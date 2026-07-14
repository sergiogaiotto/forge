// Navegação e busca GOVERNADAS do workspace (resto do item 6 — capacidade seletiva, padrão do git
// governado): o host executa DETERMINISTICAMENTE (sem LLM, sem rede) e responde com data/card.
// Este módulo é PURO (filtro/busca/render testáveis); o I/O (findFiles, readFile) fica no Controller.
// Governança: SÓ LEITURA; excludes conservadores (.env nunca entra); amostras exibidas passam pela
// máscara LGPD no Controller (maskDataSample), como toda amostra do chat.
//
// DEFESA ANTI-ReDoS EM TRÊS CAMADAS (achado blocker da revisão adversarial — provado ao vivo que só o
// cap de linha NÃO basta: backtracking catastrófico é EXPONENCIAL no tamanho da entrada, então uma
// linha de 33 chars com `(a+)+` congela o extension host por 45s):
//   1. compileSearchPattern REJEITA quantificador aninhado (star-height ≥ 2) — mata o caso exponencial
//      antes de compilar (é o único site do repo que passa regex CRU do dev ao engine; os irmãos
//      escapam ou usam padrão fixo);
//   2. searchInFiles roda sobre linhas CAPADAS (400 chars) — teto do custo POLINOMIAL residual;
//   3. searchInFiles honra um ORÇAMENTO de tempo (wall-clock) — corta a varredura agregada se estourar,
//      última linha de defesa para qualquer padrão que escape do detector.
import { hostT } from "../i18n";
import type { WorkspaceEntry } from "../shared/protocol";

export const BROWSE_MAX_ENTRIES = 60;
export const SEARCH_MAX_MATCHES = 100;
export const SEARCH_MAX_FILES = 2000; // teto de arquivos LIDOS numa busca (o browser só lista caminhos)
export const SEARCH_MAX_LINE = 400; // chars testados/exibidos por linha (custo polinomial + inchaço do card)
export const SEARCH_MAX_PATTERN = 200;
export const SEARCH_MAX_FILE_BYTES = 512 * 1024; // arquivo maior é pulado (binário/gerado, não fonte)
export const SEARCH_TIME_BUDGET_MS = 1500; // teto de wall-clock da varredura inteira (defesa em profundidade)

// Extensões que nunca valem uma busca de texto (binários/artefatos) — pular evita lixo no card e
// leitura inútil. A lista é conservadora: na dúvida, o arquivo É varrido.
const SKIP_EXT =
  /\.(png|jpe?g|gif|ico|bmp|webp|pdf|zip|gz|tgz|rar|7z|jar|vsix|exe|dll|so|dylib|woff2?|ttf|eot|otf|mp[34]|avi|mov|parquet|feather|arrow|xls[xm]?|docx?|pptx?|bin|pyc|class|lock)$/i;

export function isSearchablePath(relPath: string): boolean {
  return !SKIP_EXT.test(relPath);
}

// Catálogo do picker de menção "@" a partir dos caminhos relativos do workspace: EXCLUI arquivos sensíveis
// (segredos NUNCA viram citáveis — paridade com o auto-read/RAG, que redigem/recusam segredos), deriva as
// pastas ancestrais de cada arquivo (assim `src/core/x.ts` torna `src` e `src/core` citáveis) e ordena
// (pastas primeiro, depois arquivos; ambos alfabéticos). `isSensitive` injetado (isSensitiveFile). PURO.
export function buildMentionCatalog(relPaths: string[], isSensitive: (p: string) => boolean): WorkspaceEntry[] {
  const files = (relPaths ?? []).filter(Boolean).filter((p) => !isSensitive(p));
  const folders = new Set<string>();
  for (const f of files) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join("/"));
  }
  return [
    ...[...folders].sort().map((p) => ({ path: p, kind: "folder" as const })),
    ...files.sort().map((p) => ({ path: p, kind: "file" as const })),
  ];
}

// Quantificador SEM limite superior na posição i? `*`, `+` ou `{n,}` (o `{n,m}` finito não é o vetor
// catastrófico clássico). `?` é seguro (limite 1).
function unboundedQuantAt(src: string, i: number): boolean {
  const c = src[i];
  if (c === "*" || c === "+") return true;
  if (c === "{") return /^\{\d*,\}/.test(src.slice(i)); // {n,} sem teto
  return false;
}

// Detecta STAR-HEIGHT ≥ 2 (quantificador ilimitado APLICADO a um grupo que já contém um quantificador
// ilimitado) — a assinatura do backtracking catastrófico ((a+)+, (\w+\s?)*, (-+)+…). Heurística
// estrutural (a detecção exata é indecidível): varre com pilha de grupos, ciente de escape e classe de
// caractere. Conservadora o suficiente para os padrões reais (acidentais e maliciosos); o orçamento de
// tempo cobre o que escapar. PURO/testável.
export function hasNestedQuantifier(src: string): boolean {
  const stack: { hasQuant: boolean }[] = [];
  let escaped = false;
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === "\\") {
      escaped = true;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      continue;
    }
    if (c === "(") {
      stack.push({ hasQuant: false });
      continue;
    }
    if (c === ")") {
      const grp = stack.pop();
      const quantified = unboundedQuantAt(src, i + 1);
      // grupo repetido cujo corpo já repetia → aninhamento catastrófico
      if (grp && quantified && grp.hasQuant) return true;
      // o grupo (repetido, OU cujo corpo repete) conta como um quantificador no corpo do PAI
      if (stack.length && grp && (grp.hasQuant || quantified)) stack[stack.length - 1].hasQuant = true;
      continue;
    }
    if (unboundedQuantAt(src, i) && stack.length) stack[stack.length - 1].hasQuant = true;
  }
  return false;
}

// Compila o padrão do dev com as redes de segurança: vazio orienta, longo recusa (padrões gigantes são
// combustível de ReDoS), aninhado recusa (backtracking catastrófico — achado blocker), inválido explica.
export function compileSearchPattern(raw: string): { re: RegExp } | { error: string } {
  const p = (raw ?? "").trim();
  if (!p) return { error: hostT("wsb.search.empty") };
  if (p.length > SEARCH_MAX_PATTERN) return { error: hostT("wsb.search.tooLong", { max: SEARCH_MAX_PATTERN }) };
  if (hasNestedQuantifier(p)) return { error: hostT("wsb.search.unsafe") };
  try {
    return { re: new RegExp(p, "i") };
  } catch (e) {
    return { error: hostT("wsb.search.invalid", { error: (e as Error).message }) };
  }
}

export interface SearchMatch {
  path: string;
  line: number; // 1-based
  text: string; // linha capada em SEARCH_MAX_LINE (o Controller mascara antes de renderizar)
}

export interface SearchResult {
  matches: SearchMatch[];
  filesWithMatches: number;
  scanned: number; // arquivos efetivamente lidos
  truncated: boolean; // atingiu SEARCH_MAX_MATCHES (a varredura para cedo)
  timedOut: boolean; // estourou o orçamento de wall-clock (defesa anti-ReDoS residual)
}

// `now` injetável para teste determinístico do orçamento (o default usa o relógio real). PURO no resto.
export interface SearchOpts {
  maxMatches?: number;
  budgetMs?: number;
  now?: () => number;
}

// Busca linha a linha sobre linhas CAPADAS (custo polinomial bounded), com teto de ocorrências (para a
// varredura cedo) E orçamento de wall-clock (última defesa anti-ReDoS — corta se um padrão residual for
// lento demais). O relógio é checado no início de cada arquivo e a cada 256 linhas (a granularidade que
// importa: a linha em si já é capada em 400 chars e o padrão passou pelo detector de aninhamento).
export function searchInFiles(files: { path: string; content: string }[], re: RegExp, opts: SearchOpts = {}): SearchResult {
  const maxMatches = opts.maxMatches ?? SEARCH_MAX_MATCHES;
  const budgetMs = opts.budgetMs ?? SEARCH_TIME_BUDGET_MS;
  const now = opts.now ?? (() => Date.now());
  const started = now();
  const matches: SearchMatch[] = [];
  const withMatches = new Set<string>();
  let scanned = 0;
  let truncated = false;
  let timedOut = false;
  outer: for (const f of files) {
    if (now() - started > budgetMs) {
      timedOut = true;
      break;
    }
    scanned++;
    const lines = f.content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if ((i & 255) === 0 && now() - started > budgetMs) {
        timedOut = true;
        break outer;
      }
      const line = lines[i].length > SEARCH_MAX_LINE ? lines[i].slice(0, SEARCH_MAX_LINE) : lines[i];
      if (re.test(line)) {
        matches.push({ path: f.path, line: i + 1, text: line.trim() });
        withMatches.add(f.path);
        if (matches.length >= maxMatches) {
          truncated = true;
          break outer;
        }
      }
    }
  }
  return { matches, filesWithMatches: withMatches.size, scanned, truncated, timedOut };
}

// Marcadores de pendência — CASE-SENSITIVE de propósito: com /i, o pt/es cotidiano ("todos os
// arquivos", "todo el código") viraria falso-positivo em massa. A convenção de código é maiúscula.
export const TODO_PATTERN = /\b(TODO|FIXME|HACK|XXX)\b/;

// ---- renders (markdown host-computado; strings via hostT — 3 locales) ---------------------------

function normPrefix(p?: string): string {
  return (p ?? "").trim().replace(/\\/g, "/").replace(/^\.?\//, "").toLowerCase();
}

// Conteúdo de um code span markdown SEGURO: backtick é caractere de nome de arquivo LEGAL no Windows e
// no POSIX — um repo hostil pode enviar um path com `` ` `` que quebraria o span e injetaria markdown no
// card (achado da revisão). Troca ` por ' em qualquer coisa vinda do disco (path, linha, prefixo).
function codeSafe(s: string): string {
  return s.replace(/`/g, "'");
}

// Linha de aviso de resultado incompleto (teto de ocorrências OU orçamento de tempo estourado).
function incompleteNote(result: SearchResult): string[] {
  if (result.timedOut) return [hostT("wsb.search.timedout", { ms: SEARCH_TIME_BUDGET_MS }), ""];
  if (result.truncated) return [hostT("wsb.search.truncated", { max: SEARCH_MAX_MATCHES }), ""];
  return [];
}

// Card do /arquivos: lista capada, com filtro opcional por prefixo de caminho (pasta).
export function renderFilesCard(paths: string[], prefix: string | undefined, cap = BROWSE_MAX_ENTRIES): string {
  const norm = normPrefix(prefix);
  const filtered = norm ? paths.filter((p) => p.toLowerCase().startsWith(norm)) : paths;
  const head = norm ? hostT("wsb.files.headFiltered", { prefix: codeSafe(norm) }) : hostT("wsb.files.head");
  if (filtered.length === 0) {
    return [head, "", norm ? hostT("wsb.files.noneFiltered", { prefix: codeSafe(norm) }) : hostT("wsb.files.none")].join("\n");
  }
  const shown = [...filtered].sort().slice(0, cap);
  return [
    head,
    "",
    hostT("wsb.files.summary", { shown: shown.length, total: filtered.length }),
    "",
    ...shown.map((p) => `- \`${codeSafe(p)}\``),
    ...(filtered.length > cap ? ["", hostT("wsb.files.more", { n: filtered.length - cap })] : []),
    "",
    hostT("wsb.files.footer"),
  ].join("\n");
}

// Agrupa ocorrências por arquivo para o card (busca e TODOs compartilham o formato). Path E linha
// passam por codeSafe (repo hostil) e a linha ainda pela máscara LGPD.
function renderMatches(result: SearchResult, mask: (s: string) => string): string[] {
  const byFile = new Map<string, SearchMatch[]>();
  for (const m of result.matches) {
    const arr = byFile.get(m.path) ?? [];
    arr.push(m);
    byFile.set(m.path, arr);
  }
  const lines: string[] = [];
  for (const [path, ms] of byFile) {
    lines.push(`**\`${codeSafe(path)}\`**`);
    for (const m of ms) lines.push(`- L${m.line}: \`${codeSafe(mask(m.text))}\``);
    lines.push("");
  }
  return lines;
}

export function renderSearchCard(pattern: string, result: SearchResult, mask: (s: string) => string): string {
  const safePattern = codeSafe(pattern);
  if (result.matches.length === 0) {
    const body = result.timedOut ? hostT("wsb.search.timedout", { ms: SEARCH_TIME_BUDGET_MS }) : hostT("wsb.search.none", { pattern: safePattern, files: result.scanned });
    return [hostT("wsb.search.head", { pattern: safePattern }), "", body].join("\n");
  }
  return [
    hostT("wsb.search.head", { pattern: safePattern }),
    "",
    hostT("wsb.search.summary", { count: result.matches.length, files: result.filesWithMatches, scanned: result.scanned }),
    "",
    ...renderMatches(result, mask),
    ...incompleteNote(result),
    hostT("wsb.footer"),
  ].join("\n");
}

export function renderTodoCard(result: SearchResult, mask: (s: string) => string): string {
  if (result.matches.length === 0) {
    return [hostT("wsb.todo.head"), "", hostT("wsb.todo.none", { files: result.scanned })].join("\n");
  }
  return [
    hostT("wsb.todo.head"),
    "",
    hostT("wsb.search.summary", { count: result.matches.length, files: result.filesWithMatches, scanned: result.scanned }),
    "",
    ...renderMatches(result, mask),
    ...incompleteNote(result),
    hostT("wsb.footer"),
  ].join("\n");
}
