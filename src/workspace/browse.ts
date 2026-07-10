// Navegação e busca GOVERNADAS do workspace (resto do item 6 — capacidade seletiva, padrão do git
// governado): o host executa DETERMINISTICAMENTE (sem LLM, sem rede) e responde com data/card.
// Este módulo é PURO (filtro/busca/render testáveis); o I/O (findFiles, readFile) fica no Controller.
// Governança: SÓ LEITURA; excludes conservadores (.env nunca entra); caps de arquivos/ocorrências/
// linha (protegem o chat de despejo E limitam a superfície de ReDoS de um regex do dev — o teste roda
// linha a linha sobre linhas capadas, nunca sobre o arquivo inteiro); amostras exibidas passam pela
// máscara LGPD no Controller (maskDataSample), como toda amostra do chat.
import { hostT } from "../i18n";

export const BROWSE_MAX_ENTRIES = 60;
export const SEARCH_MAX_MATCHES = 100;
export const SEARCH_MAX_FILES = 2000; // teto de arquivos LIDOS numa busca (o browser só lista caminhos)
export const SEARCH_MAX_LINE = 400; // chars testados/exibidos por linha (ReDoS + inchaço do card)
export const SEARCH_MAX_PATTERN = 200;
export const SEARCH_MAX_FILE_BYTES = 512 * 1024; // arquivo maior é pulado (binário/gerado, não fonte)

// Extensões que nunca valem uma busca de texto (binários/artefatos) — pular evita lixo no card e
// leitura inútil. A lista é conservadora: na dúvida, o arquivo É varrido.
const SKIP_EXT =
  /\.(png|jpe?g|gif|ico|bmp|webp|pdf|zip|gz|tgz|rar|7z|jar|vsix|exe|dll|so|dylib|woff2?|ttf|eot|otf|mp[34]|avi|mov|parquet|feather|arrow|xls[xm]?|docx?|pptx?|bin|pyc|class|lock)$/i;

export function isSearchablePath(relPath: string): boolean {
  return !SKIP_EXT.test(relPath);
}

// Compila o padrão do dev com as redes de segurança: vazio/curto demais orienta, longo demais recusa
// (padrões gigantes são o combustível clássico de ReDoS), inválido explica o erro do engine.
export function compileSearchPattern(raw: string): { re: RegExp } | { error: string } {
  const p = (raw ?? "").trim();
  if (!p) return { error: hostT("wsb.search.empty") };
  if (p.length > SEARCH_MAX_PATTERN) return { error: hostT("wsb.search.tooLong", { max: SEARCH_MAX_PATTERN }) };
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
}

// Busca linha a linha sobre linhas CAPADAS — trabalho linear no tamanho do conteúdo, nunca um regex
// sobre o arquivo inteiro (mesma disciplina anti-ReDoS do dodCheck). Para no teto de ocorrências.
export function searchInFiles(files: { path: string; content: string }[], re: RegExp, maxMatches = SEARCH_MAX_MATCHES): SearchResult {
  const matches: SearchMatch[] = [];
  const withMatches = new Set<string>();
  let scanned = 0;
  let truncated = false;
  outer: for (const f of files) {
    scanned++;
    const lines = f.content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
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
  return { matches, filesWithMatches: withMatches.size, scanned, truncated };
}

// Marcadores de pendência — CASE-SENSITIVE de propósito: com /i, o pt/es cotidiano ("todos os
// arquivos", "todo el código") viraria falso-positivo em massa. A convenção de código é maiúscula.
export const TODO_PATTERN = /\b(TODO|FIXME|HACK|XXX)\b/;

// ---- renders (markdown host-computado; strings via hostT — 3 locales) ---------------------------

function normPrefix(p?: string): string {
  return (p ?? "").trim().replace(/\\/g, "/").replace(/^\.?\//, "").toLowerCase();
}

// Card do /arquivos: lista capada, com filtro opcional por prefixo de caminho (pasta).
export function renderFilesCard(paths: string[], prefix: string | undefined, cap = BROWSE_MAX_ENTRIES): string {
  const norm = normPrefix(prefix);
  const filtered = norm ? paths.filter((p) => p.toLowerCase().startsWith(norm)) : paths;
  const head = norm ? hostT("wsb.files.headFiltered", { prefix: norm }) : hostT("wsb.files.head");
  if (filtered.length === 0) {
    return [head, "", norm ? hostT("wsb.files.noneFiltered", { prefix: norm }) : hostT("wsb.files.none")].join("\n");
  }
  const shown = [...filtered].sort().slice(0, cap);
  return [
    head,
    "",
    hostT("wsb.files.summary", { shown: shown.length, total: filtered.length }),
    "",
    ...shown.map((p) => `- \`${p}\``),
    ...(filtered.length > cap ? ["", hostT("wsb.files.more", { n: filtered.length - cap })] : []),
    "",
    hostT("wsb.files.footer"),
  ].join("\n");
}

// Agrupa ocorrências por arquivo para o card (busca e TODOs compartilham o formato).
function renderMatches(result: SearchResult, mask: (s: string) => string): string[] {
  const byFile = new Map<string, SearchMatch[]>();
  for (const m of result.matches) {
    const arr = byFile.get(m.path) ?? [];
    arr.push(m);
    byFile.set(m.path, arr);
  }
  const lines: string[] = [];
  for (const [path, ms] of byFile) {
    lines.push(`**\`${path}\`**`);
    for (const m of ms) lines.push(`- L${m.line}: \`${mask(m.text).replace(/`/g, "'")}\``);
    lines.push("");
  }
  return lines;
}

export function renderSearchCard(pattern: string, result: SearchResult, mask: (s: string) => string): string {
  const safePattern = pattern.replace(/`/g, "'");
  if (result.matches.length === 0) {
    return [hostT("wsb.search.head", { pattern: safePattern }), "", hostT("wsb.search.none", { pattern: safePattern, files: result.scanned })].join("\n");
  }
  return [
    hostT("wsb.search.head", { pattern: safePattern }),
    "",
    hostT("wsb.search.summary", { count: result.matches.length, files: result.filesWithMatches, scanned: result.scanned }),
    "",
    ...renderMatches(result, mask),
    ...(result.truncated ? [hostT("wsb.search.truncated", { max: SEARCH_MAX_MATCHES }), ""] : []),
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
    ...(result.truncated ? [hostT("wsb.search.truncated", { max: SEARCH_MAX_MATCHES }), ""] : []),
    hostT("wsb.footer"),
  ].join("\n");
}
