// Gate WORKSPACE-WIDE do Modo Projeto: em vez de medir só a PRESENÇA dos arquivos (o gate antigo,
// que marcava "complete" por existir), materializa TODAS as propostas juntas numa árvore temporária e
// roda compileall + mypy sobre o CONJUNTO — pegando o drift de contrato cross-file (ex.: importar um
// `OrderStatus` que nenhum arquivo define) que só aparece quando os arquivos são vistos JUNTOS.
//
// Este módulo é PURO (materialização/parse/decisão testáveis sem spawnar processo). O I/O (mkdtemp,
// spawn do python) fica no Controller.runProjectGate, que orquestra e alimenta `entry.gateOk`.
import * as path from "node:path";
import { ProjectLanguage, ValidatorResult } from "../shared/protocol";

export const SYNTHETIC_INIT = "__init__.py";

// Normaliza um caminho relativo para casar propostas × saída das ferramentas: separadores pra frente,
// sem `./` inicial. NÃO mexe em caixa (paths são case-sensitive em Linux). O colapso de barras duplas é
// ESSENCIAL: no Windows, o `*** Error compiling {!r}...` do compileall usa repr(), que DOBRA as barras
// invertidas (`.\\adapters\\x.py`) — sem colapsar, viraria `/adapters//x.py` e não casaria a proposta.
export function normGatePath(p: string): string {
  return (p ?? "")
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "")
    .trim();
}

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

// Um diretório só pode virar pacote Python se TODOS os seus segmentos forem identificadores válidos
// (letra/underscore seguidos de word-chars). Diretórios comuns em projetos gerados como `my-app`,
// `api-v2`, `order.service` ou `2fa` NÃO são: semear `__init__.py` neles faz o mypy ABORTAR (exit 2,
// "X contains __init__.py but is not a valid Python package name") sem atribuir erro — e o abort MASCARA
// o drift real de pacotes VÁLIDOS na mesma run. Sem o `__init__.py`, o mypy checa o arquivo standalone e
// ainda atribui os erros. (Achado da revisão adversarial, reproduzido ao vivo com mypy 2.1.0.)
const PKG_SEGMENT = /^[A-Za-z_]\w*$/;
function isPackageDir(dir: string): boolean {
  return dir.split("/").every((seg) => PKG_SEGMENT.test(seg));
}

// Diretórios que precisam de um `__init__.py` SINTÉTICO para virarem pacotes Python importáveis (sem
// isso, `from a.b.c import X` não resolve no mypy e o gate perderia o drift cross-file). Regra: todo
// ancestral de um `.py` é candidato a pacote; a RAIZ (string vazia) nunca vira pacote; diretórios que já
// têm um `__init__.py` entre as próprias propostas são pulados (não sobrescreve o do modelo); e nomes
// que não são identificadores Python válidos são EXCLUÍDOS (senão o mypy aborta e mascara o drift). Puro.
export function syntheticInitDirs(relPaths: string[], language: ProjectLanguage = "python"): string[] {
  if (language !== "python") return []; // só Python precisa de __init__.py; TS/JS resolvem por caminho
  const norm = relPaths.map(normGatePath).filter(Boolean);
  const alreadyPkg = new Set(
    norm.filter((p) => p === SYNTHETIC_INIT || p.endsWith("/" + SYNTHETIC_INIT)).map((p) => dirOf(p))
  );
  const needed = new Set<string>();
  for (const p of norm) {
    if (!p.toLowerCase().endsWith(".py")) continue;
    let dir = dirOf(p);
    while (dir) {
      needed.add(dir);
      dir = dirOf(dir);
    }
  }
  return [...needed].filter((d) => !alreadyPkg.has(d) && isPackageDir(d)).sort();
}

// Relativiza um caminho da SAÍDA da ferramenta contra a raiz temp e normaliza. As ferramentas rodam com
// cwd=raiz e argumento `.`, então emitem caminhos relativos; o ramo absoluto é defensivo.
function relToRoot(root: string, p: string): string {
  const raw = (p ?? "").trim();
  if (raw && (path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw))) {
    return normGatePath(path.relative(root, raw));
  }
  return normGatePath(raw);
}

function push(map: Map<string, string[]>, key: string, ...msgs: string[]): void {
  if (!key) return;
  const arr = map.get(key) ?? [];
  arr.push(...msgs);
  map.set(key, arr);
}

// compileall (-q) imprime `*** Error compiling '<path>'...` seguido do traceback do SyntaxError. Ancora
// no path e acumula as linhas seguintes (a mensagem) até a próxima âncora/linha em branco. Puro.
export function parseCompileallErrors(output: string, root = ""): Map<string, string[]> {
  const map = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of (output ?? "").split(/\r?\n/)) {
    const m = /Error compiling ['"]?(.+?)['"]?(?:\.\.\.)?\s*$/.exec(line);
    if (m) {
      current = relToRoot(root, m[1]);
      push(map, current, line.trim());
      continue;
    }
    if (!line.trim()) {
      current = null;
      continue;
    }
    if (current) push(map, current, line.trim());
  }
  return map;
}

// mypy imprime `path:line[:col]: error|note: msg [code]`. Coleta só `error` (notes são contexto). Puro.
export function parseMypyErrors(output: string, root = ""): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const line of (output ?? "").split(/\r?\n/)) {
    const m = /^(.*?):(\d+):(?:\d+:)?\s*(error|note):\s*(.*)$/.exec(line);
    if (!m || m[3] !== "error") continue;
    push(map, relToRoot(root, m[1]), `linha ${m[2]}: ${m[4].trim()}`);
  }
  return map;
}

// mypy não instalado ≠ mypy reprovou: `python -m mypy` sem o pacote sai != 0 com "No module named mypy"
// (não é ENOENT — o python EXISTE). Nesse caso o gate degrada para consultivo, não bloqueia.
export function mypyUnavailable(result: ValidatorResult): boolean {
  if (result.status === "skipped") return true;
  if (result.status !== "failed") return false;
  return /no module named ['"]?mypy|mypy: (command )?not found|is not recognized as an internal|modulenotfounderror: no module named ['"]mypy/i.test(result.output ?? "");
}

// ---- TypeScript (tsc --noEmit) — P4 gate multi-linguagem -----------------------------------------------

export interface TscError {
  path: string;
  line: number;
  code: string; // ex.: "TS2307", "TS1005"
  message: string;
}

// Erros do tsc que são RUÍDO DE TERCEIROS quando o import é BARE (não-relativo): sem node_modules na árvore
// temp, o tsc não acha 'react'/'express'/@types. Filtramos esses SÓ para imports bare — mantemos os de
// imports RELATIVOS (./ ../), que são drift interno REAL (um arquivo do projeto que não existe/exporta).
const TS_MISSING_MODULE_CODES = new Set(["TS2307", "TS2792", "TS7016", "TS2688", "TS2503"]);

// Parseia a saída do `tsc --noEmit --pretty false`. Cobre os dois formatos: `path(l,c): error TSxxxx: msg`
// (pretty=false) e `path:l:c - error TSxxxx: msg` (pretty). Coleta só `error`. Filtra o ruído de deps de
// terceiros (import bare não-resolvido). Puro.
export function parseTscErrors(output: string, root = ""): TscError[] {
  const out: TscError[] = [];
  for (const raw of (output ?? "").split(/\r?\n/)) {
    const m = /^(.+?)(?:\((\d+),\d+\):|:(\d+):\d+ -)\s+error\s+(TS\d+):\s*(.*)$/.exec(raw);
    if (!m) continue;
    const code = m[4];
    const message = (m[5] ?? "").trim();
    // Import bare não-resolvido (dep de terceiros ausente) → ruído; import relativo → drift interno real.
    if (TS_MISSING_MODULE_CODES.has(code)) {
      const mod = /['"]([^'"]+)['"]/.exec(message);
      if (mod && !mod[1].startsWith(".")) continue;
    }
    out.push({ path: relToRoot(root, m[1]), line: Number(m[2] || m[3]) || 0, code, message });
  }
  return out;
}

// TS1xxx = erros de SINTAXE/gramática (o arquivo nem PARSEIA) — inequívocos, bloqueiam. TS2xxx+ = semântica/
// tipo, ruidosos sem node_modules → advisory. (Decisão (A): sintaxe bloqueia, tipo é consultivo.)
export function isTscSyntaxError(code: string): boolean {
  return /^TS1\d{3}$/.test(code);
}

// Agrupa erros do tsc por arquivo no formato do gate (Map<path, string[]>).
export function tscErrorsToMap(errors: TscError[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const e of errors) push(map, e.path, `linha ${e.line}: [${e.code}] ${e.message}`);
  return map;
}

// tsc não disponível ≠ tsc reprovou: sem o binário (ENOENT) o runner marca "skipped"; uma mensagem de
// "command not found"/"is not recognized" ou o loader do Node não achar o pacote typescript também. Nesses
// casos o gate TS degrada para consultivo. CRUCIAL: avalia só sobre as linhas que NÃO são diagnóstico do tsc
// (`error TSdddd:`). Senão, um projeto legítimo que importa o pacote `typescript` faz o PRÓPRIO compilador
// emitir `error TS2307: Cannot find module 'typescript'`, e isso desligaria o gate (incl. o bloqueio de
// sintaxe) por engano (achado da revisão). Um relatório COM diagnósticos significa que o tsc RODOU.
export function tscUnavailable(result: ValidatorResult): boolean {
  if (result.status === "skipped") return true;
  if (result.status !== "failed") return false;
  const nonDiag = (result.output ?? "")
    .split(/\r?\n/)
    .filter((l) => !/error\s+TS\d+:/i.test(l))
    .join("\n");
  return /is not recognized as an internal|command not found|error: cannot find module ['"]typescript|no such file or directory/i.test(nonDiag);
}

// ---- Go (gofmt = sintaxe | go build/vet = advisory) — P4 gate multi-linguagem -------------------------

// gofmt escreve os erros de SINTAXE em stderr no formato `arquivo.go:linha[:col]: msg`. Como o gofmt só
// PARSEIA (não resolve imports nem tipa), TODO erro dele é sintaxe pura → bloqueia — e é IMPOSSÍVEL um dep
// de terceiros ausente virar erro aqui (ao contrário do `go build`), o que o torna o primitivo robusto e
// offline do gate Go. O `-l` faz o stdout listar só NOMES de arquivo (sem `:linha`), que este parser ignora.
// A âncora `.go:` (lazy) evita confundir o `:` do drive do Windows num caminho absoluto. Puro.
export function parseGofmtErrors(output: string, root = ""): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const raw of (output ?? "").split(/\r?\n/)) {
    const m = /^(.+?\.go):(\d+)(?::\d+)?:\s*(.*)$/.exec(raw.trim());
    if (!m) continue;
    push(map, relToRoot(root, m[1]), `linha ${m[2]}: ${(m[3] ?? "").trim()}`);
  }
  return map;
}

export interface GoBuildError {
  path: string;
  line: number;
  message: string;
}

// Ruído de RESOLUÇÃO de dependências do `go build`/`go vet` OFFLINE (GOPROXY=off, sem module cache): não é
// defeito do código gerado, é a ausência de deps de terceiros que NÃO baixamos (egress deny-by-default).
// É filtrado do advisory — o análogo do `cannot find module` de import BARE no gate TS. Conservador: filtrar
// demais só REDUZ avisos (que nem bloqueiam); deixar ruído passar é que enganaria. Só resolução de terceiros.
const GO_DEP_NOISE =
  /no required module provides package|module lookup disabled|cannot find module|missing go\.sum|not in std\b|not in GOROOT|cannot find main module|go\.mod file not found|updates to go\.mod needed|build constraints exclude all|no Go files in|malformed (?:module|import) path|disabled by GOFLAGS|GOPROXY|GOTOOLCHAIN|to add it:|^go(?: get|:) /i;

// Parseia a saída do `go build ./...` / `go vet ./...`: linhas `# pacote` são cabeçalho (contexto → pula);
// erros são `arquivo.go:linha[:col]: msg`. Filtra o RUÍDO de deps ausentes (GO_DEP_NOISE, offline não baixa
// terceiros), mantendo os erros REAIS do código — símbolo indefinido e import/variável não usados (em Go são
// ERRO de compilação, não aviso), que são o drift de contrato cross-file. Advisory: a decisão de bloqueio é
// só do gofmt (sintaxe). Puro.
export function parseGoBuildErrors(output: string, root = ""): GoBuildError[] {
  const out: GoBuildError[] = [];
  for (const raw of (output ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue; // cabeçalho de pacote / linha vazia
    if (GO_DEP_NOISE.test(line)) continue; // ruído de resolução de deps → não é defeito do código
    const m = /^(.+?\.go):(\d+)(?::\d+)?:\s*(.*)$/.exec(line);
    if (!m) continue;
    const message = (m[3] ?? "").trim();
    if (GO_DEP_NOISE.test(message)) continue; // erro atribuído a arquivo mas de dep ausente (ex.: "no required module...")
    out.push({ path: relToRoot(root, m[1]), line: Number(m[2]) || 0, message });
  }
  return out;
}

// Agrupa os erros do go build por arquivo no formato do gate (Map<path, string[]>). (Reservado — hoje o Go
// build é advisory; se um dia virar bloqueante por-arquivo, isto os atribui como o tscErrorsToMap.)
export function goBuildErrorsToMap(errors: GoBuildError[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const e of errors) push(map, e.path, `linha ${e.line}: ${e.message}`);
  return map;
}

// Um resultado de checagem já rodado (result) mais os erros por-arquivo extraídos da sua saída.
export interface GateCheckResult {
  result: ValidatorResult;
  errors: Map<string, string[]>;
}

export interface ProjectGateSummary {
  advisory: boolean; // nenhuma checagem de GATE conseguiu rodar → nada é bloqueado
  ran: string[]; // labels das checagens que executaram (ok ou failed)
  skipped: string[]; // labels puladas (não instaladas / timeout)
  fileErrors: { path: string; errors: string[] }[]; // atribuídos a um arquivo → bloqueiam esse arquivo
  // Violações do gate de ARQUITETURA (regra de camadas). BLOQUEIAM o Aplicar como os fileErrors, mas ficam
  // SEPARADAS: não entram no summarizeGate (para não poluir advisory/parcial do toolchain) nem no auto-reparo
  // de type-drift. Preenchido pelo Controller.runProjectGate, não pelo summarizeGate. Ver util/layerCheck.ts.
  architectureErrors?: { path: string; errors: string[] }[];
  // Achados da DEFINIÇÃO DE PRONTO (DoD): requisitos AUSENTES do conjunto (manifesto/teste/README). São
  // project-level (a falta não se atribui a um arquivo) e BLOQUEIAM o Aplicar de TODOS quando o conjunto
  // está completo. Também FORA do summarizeGate e do auto-reparo. Preenchido pelo Controller. Ver
  // util/dodCheck.ts.
  dodErrors?: string[];
  // Achados de SEGURANÇA (bandit/SAST). `securityErrors` são os BLOQUEANTES (severidade+confiança altas),
  // por-arquivo — bloqueiam o Aplicar como a arquitetura. `securityAdvisories` são os demais (advisory),
  // project-level, só surface. Ambos FORA do summarizeGate e do auto-reparo. Ver util/banditParse.ts.
  securityErrors?: { path: string; errors: string[] }[];
  securityAdvisories?: string[];
  projectErrors: string[]; // reprovou SEM atribuir a arquivo → bloqueia todos os .py (fallback)
  partial: boolean; // compilou (sintaxe ok) mas o mypy NÃO rodou → coerência cross-file NÃO verificada (NÃO é verde)
  summary: string;
}

// O "Aplicar tudo" deve exigir CONFIRMAÇÃO explícita? Sim quando o conjunto compilou mas a coerência
// cross-file NÃO foi verificada (gate `partial`) num projeto PYTHON — onde o mypy é o único checador de
// contrato (import/atributo fantasma) e sua ausência esconde o drift que faz "instala e não roda". SÓ
// Python: em Go/Java o compilador-de-contrato (go build/javac) é advisory de propósito (offline/sem JDK),
// não uma verificação que se espera existir — exigir confirmação lá seria atrito falso. Puro/testável.
export function requiresContractConfirmation(language: ProjectLanguage, partial: boolean): boolean {
  return language === "python" && partial;
}

// A verdade CRUA para a política do admin: o contrato cross-file está verificado? Diferente da
// confirmação acima, aqui `advisory` (NADA rodou — sem Python nenhum, ou o próprio gate falhou) TAMBÉM
// conta como não-verificado: um estado estritamente mais fraco que o "parcial" não pode ter enforcement
// mais fraco (senão degradar o ambiente viraria o bypass da política). E não há carve-out por outros
// bloqueios — a supressão `totalBlocked===0` vale só para a SEMÂNTICA de confirmação. Puro/testável.
export function contractUnverified(language: ProjectLanguage, partial: boolean, advisory: boolean): boolean {
  return language === "python" && (partial || advisory);
}

// Decide o destino do "Aplicar tudo" quando o contrato cross-file não foi verificado. Padrão
// (blockPolicy=false): confirmação explícita — o dev pode assumir com "Aplicar sem verificar contrato"
// (force). Com a política do admin `forge.gate.blockUnverifiedContract`, NÃO há escape: bloqueia até o
// contrato ser verificado de fato ("Preparar ambiente" + "Re-verificar contrato") — "projeto que roda"
// deixa de depender do toolchain presente no ambiente do dev. Puro/testável.
export type ContractGateDecision = "proceed" | "confirm" | "block";
export function contractGateDecision(unverified: boolean, blockPolicy: boolean, force: boolean): ContractGateDecision {
  if (!unverified) return "proceed";
  if (blockPolicy) return "block";
  return force ? "proceed" : "confirm";
}

// Consolida os resultados das checagens numa decisão de gate. Só uma checagem de GATE (gate:true) que
// REALMENTE rodou e reprovou (status "failed") contribui bloqueio — skipped nunca bloqueia (degradação
// segura). Uma reprovação sem erro atribuível a arquivo vira `projectErrors` (bloqueio amplo). Puro.
export function summarizeGate(checks: GateCheckResult[]): ProjectGateSummary {
  const ran: string[] = [];
  const skipped: string[] = [];
  const merged = new Map<string, string[]>();
  const projectErrors: string[] = [];
  let anyGateRan = false;

  for (const c of checks) {
    const r = c.result;
    if (r.status === "skipped") {
      skipped.push(r.label);
      continue;
    }
    ran.push(r.label);
    if (r.gate) anyGateRan = true;
    if (r.status === "failed" && r.gate) {
      if (c.errors.size > 0) {
        for (const [file, msgs] of c.errors) push(merged, file, ...msgs);
      } else {
        // Reprovou mas o parser não localizou o arquivo — mantém a força do gate: bloqueia amplo.
        projectErrors.push(`${r.label}: ${(r.output || "reprovou sem detalhes").slice(0, 600)}`);
      }
    }
  }

  const fileErrors = [...merged]
    .map(([p, errors]) => ({ path: p, errors }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const advisory = !anyGateRan;
  const mypyRan = ran.some((l) => /mypy/i.test(l)); // o mypy é o que pega o DRIFT de contrato cross-file
  // "Parcial": um gate rodou (compileall) e não achou erro, mas o mypy NÃO rodou — logo a coerência
  // cross-file (import/atributo fantasma) NÃO foi verificada. NÃO é verde: a UI deve avisar, não celebrar.
  const partial = !advisory && fileErrors.length === 0 && projectErrors.length === 0 && !mypyRan;
  // Só BLOQUEIA arquivos com erro ATRIBUÍDO (a ferramenta apontou o arquivo). Uma reprovação sem
  // atribuição (traceback do próprio tooling, env quebrado) é ANÔMALA e vira aviso não-bloqueante — não
  // dá para saber se é defeito do código ou da ferramenta, e um bloqueio amplo por env seria falso.
  const summary = advisory
    ? "Gate consultivo: compileall/mypy indisponíveis no ambiente — nada foi bloqueado (o projeto pode não rodar)."
    : fileErrors.length > 0
      ? `Gate reprovou: ${fileErrors.length} arquivo(s) não compilam/importam. O "Aplicar" deles está bloqueado até corrigir.`
      : projectErrors.length > 0
        ? "Gate rodou mas não consegui localizar a falha por arquivo (veja os detalhes) — nada foi bloqueado."
        : mypyRan
          ? "Gate verde: o conjunto compila e importa (compileall + mypy sem erros de contrato)."
          : "Gate parcial: compilou sem erro de sintaxe (compileall), mas o mypy não rodou — o drift de contrato cross-file NÃO foi verificado.";

  return { advisory, ran, skipped, fileErrors, projectErrors, partial, summary };
}
