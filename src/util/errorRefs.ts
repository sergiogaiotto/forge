// Extrai os caminhos de ARQUIVO citados num erro/traceback/log que o dev colou, para o HOST lê-los do
// workspace e injetá-los no contexto da geração. Motivação: o modelo NÃO tem ferramenta de leitura de
// arquivo (o provider não recebe tools), então sem isto ele PEDE o arquivo ao dev ("cole o conteúdo de
// appointment.py…") em vez de corrigir sozinho — mesmo tendo o workspace à mão. Aqui só EXTRAÍMOS
// candidatos crus (absolutos ou relativos); a contenção no workspace é do safeWorkspacePath do chamador,
// que descarta stdlib e paths externos (ex.: .../Python311/Lib/dataclasses.py). Puro/testável.
//
// ANTI-ReDoS (achado da revisão): o regex de PATH:linha faz backtracking O(n) por token sem delimitador,
// então rodá-lo sobre o texto CRU (que pode ter uma linha gigante sem espaço — base64/data-URI/minificado)
// seria O(n²) e congelaria o extension host (Node single-thread). Defesa: processa LINHA A LINHA e PULA
// linhas maiores que MAX_LINE (um caminho de erro real é curto), limitando cada match a entrada pequena.

const MAX_CANDIDATES = 20;
const MAX_LINE = 2000; // uma linha de erro/frame real cabe folgado; acima disto não é caminho → pula
const MAX_LINES = 5000; // teto de linhas varridas (defesa contra log gigantesco)

// Frame de traceback Python: File "PATH", line N  (PATH entre aspas → pode conter ':' do drive Windows).
const PY_FRAME = /File\s+"([^"\n]{1,400})",\s*line\s+\d+/g;
// Compilador/linter/pytest/mypy: PATH:linha — PATH termina na extensão, seguido de ':<dígitos>'. Duas
// formas: drive Windows (C:\...ext) ou relativo/unix (...ext). O `{1,400}` limita o backtracking por token.
const PATH_LINE = /([A-Za-z]:[\\/][^\s:"'()]{1,400}\.[A-Za-z0-9]{1,6}|[^\s:"'()]{1,400}\.[A-Za-z0-9]{1,6}):\d+/g;

// Denylist de arquivos sensíveis que o auto-read NUNCA deve ler e mandar ao gateway. O dev não
// escolheu anexar estes arquivos — foram lidos só por APARECEREM num traceback colado — então
// segredos (.env, chaves privadas, credenciais, keystores) não podem vazar no contexto da geração.
// Espelha e AMPLIA o exclude do browse governado (dispatchWorkspaceCommand exclui .env/.env.*), que
// hoje o auto-read não tem (achado #02 do survey). Casado pelo BASENAME, case-insensitive — o path
// já foi contido na raiz do workspace pelo chamador (safeWorkspacePath + realpath).
// Extensões de CÓDIGO-FONTE. Um arquivo assim citado num traceback é EXATAMENTE o que o auto-read
// existe para ler (um `config.py` com SECRET_KEY é MASCARADO pela redação, não bloqueado). Serve para
// não confundir um módulo `credentials.py`/`secrets_manager.py` (fonte) com o STORE de segredos
// `credentials`/`secrets.yaml` — over-block de fonte degradaria o recurso sem ganho de segurança.
const SOURCE_EXT =
  /\.(py|pyi|ipynb|ts|tsx|js|jsx|mjs|cjs|vue|svelte|go|rs|java|kt|scala|rb|php|cs|cpp|cc|c|h|hpp|sql|r|swift|dart)$/i;

// SEMPRE sensível, qualquer que seja a extensão: .env, dotfiles de credencial conhecidos (direnv/
// netrc/pgpass/npm/pypi/git), chaves SSH extensionless e chaves/keystores por extensão.
const SENSITIVE_ALWAYS: RegExp[] = [
  /^\.env(\.[^\\/]*)?$/i, // .env, .env.local, .env.production
  /\.env$/i, // production.env, config.env
  /^\.(envrc|netrc|pgpass|npmrc|pypirc|dockercfg|git-credentials)$/i, // dotfiles de credencial (achado #04 refutado só p/ o caso sem prefixo — com caminho, .envrc é extraível)
  /^_netrc$/i, // variante Windows do .netrc
  /^id_(rsa|dsa|ecdsa|ed25519)$/i, // chaves SSH privadas (extensionless)
  /\.(pem|key|pfx|p12|pkcs12|keystore|jks|ppk|asc|gpg)$/i, // chaves/keystores por extensão
];

// Sensível SÓ quando NÃO for código-fonte (um `.py`/`.ts` é MÓDULO — o STORE de segredo é sem
// extensão ou tem extensão de dados). A rede de segurança de CONTEÚDO (looksLikePrivateKey) faz o
// backstop de um arquivo-fonte que por acaso carregue um PEM. Evita falso-positivo em módulos de
// cripto legítimos (private_key.py, secrets_manager.py, credential_service.ts) — achado #03.
const SENSITIVE_UNLESS_SOURCE: RegExp[] = [
  /(^|[._-])credentials?([._-].*)?$/i, // credentials, aws_credentials, credentials.json
  /(^|[._-])secrets?([._-].*)?$/i, // secrets, secrets.yaml, app_secret.txt
  /(^|[._-])(id_rsa|privkey|private[._-]?key)([._-].*)?$/i, // *_private_key.txt, privkey (não-fonte)
];

/** true se o BASENAME do caminho for um arquivo de segredo que o auto-read não deve ler. Puro/testável. */
export function isSensitiveFile(p: string): boolean {
  const base = (p.split(/[\\/]/).pop() ?? p).trim();
  if (SENSITIVE_ALWAYS.some((re) => re.test(base))) return true;
  if (!SOURCE_EXT.test(base) && SENSITIVE_UNLESS_SOURCE.some((re) => re.test(base))) return true;
  return false;
}

// Rede de segurança de CONTEÚDO: um arquivo cujo NOME escapou à denylist (ex.: um `.pem` renomeado
// para `config.txt`) mas cujo corpo é uma chave privada PEM. Casa o cabeçalho PKCS#1/PKCS#8/EC/DSA/
// OpenSSH/ENCRYPTED. Barra ANTES da redação (redactSecrets não pega bloco PEM — ver achado #08).
const PEM_PRIVATE_KEY = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?:[- ]BLOCK)?-----/;

/** true se o conteúdo contém um bloco de chave privada PEM. Puro/testável. */
export function looksLikePrivateKey(content: string): boolean {
  return PEM_PRIVATE_KEY.test(content);
}

export function extractReferencedPaths(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const add = (p: string | undefined): void => {
    if (!p) return;
    const clean = p.trim().replace(/^['"]+|['"]+$/g, "");
    // Só caminhos com uma extensão de arquivo plausível — evita capturar tokens soltos.
    if (clean && /\.[A-Za-z0-9]{1,6}$/.test(clean) && !out.includes(clean) && out.length < MAX_CANDIDATES) {
      out.push(clean);
    }
  };
  const lines = text.split("\n");
  const n = Math.min(lines.length, MAX_LINES);
  for (let i = 0; i < n && out.length < MAX_CANDIDATES; i++) {
    const line = lines[i];
    if (line.length > MAX_LINE) continue; // linha longa demais para ser um caminho → pula (anti-ReDoS)
    for (const m of line.matchAll(PY_FRAME)) add(m[1]);
    for (const m of line.matchAll(PATH_LINE)) add(m[1]);
  }
  return out;
}
