// Lógica PURA do picker de menção "@" do composer (arquivos/pastas do workspace), no molde da paleta "/".
// Testável sem DOM (ver src/test/mentions.test.ts); o DevPanel só faz o glue (popover, teclado, anexo).
import type { WorkspaceEntry } from "../../src/shared/protocol";

export interface MentionToken {
  query: string; // texto após o "@" até o caret (sem espaços)
  start: number; // índice do "@" no texto (para substituir/remover o token ao selecionar)
}

// Extrai o token de menção "@…" na posição do CARET, ou null. Dispara só quando o "@" inicia um token —
// precedido por início-de-texto ou espaço (assim `a@b.com` de e-mail NÃO abre o picker) — e não há espaço
// entre o "@" e o caret (um espaço FECHA o token). O query pode conter caminho (`/`, `.`, `-`, `_`). Puro.
export function atMentionToken(text: string, caret: number): MentionToken | null {
  const c = Math.max(0, Math.min(caret ?? 0, (text ?? "").length));
  const upto = (text ?? "").slice(0, c);
  const at = upto.lastIndexOf("@");
  if (at === -1) return null;
  const before = at === 0 ? "" : upto[at - 1];
  if (before && !/\s/.test(before)) return null; // "@" no meio de uma palavra → não é menção
  const query = upto.slice(at + 1);
  if (/\s/.test(query)) return null; // espaço no token → fechou
  return { query, start: at };
}

// Substitui o token de menção pelo texto escolhido (ex.: limpar o `@query`, ou inserir uma referência),
// devolvendo o novo texto e a nova posição do caret. Consome o token INTEIRO — de `start` (o "@") até o
// próximo espaço/fim — NÃO só até o caret (o caret pode estar no MEIO do token, via ← ou clique; usar só o
// `query` até o caret deixaria a cauda como lixo — achado da revisão). Puro. O DevPanel aplica no textarea.
export function replaceMention(text: string, token: MentionToken, replacement: string): { text: string; caret: number } {
  const t = text ?? "";
  const head = t.slice(0, token.start);
  const run = /^\S*/.exec(t.slice(token.start + 1)); // do "@" em diante, avança sobre TODOS os não-espaços
  const tokenEnd = token.start + 1 + (run ? run[0].length : 0);
  const tail = t.slice(tokenEnd);
  return { text: head + replacement + tail, caret: head.length + replacement.length };
}

// Texto inserido no composer ao escolher uma menção: `@caminho` (ou `@caminho/` p/ pasta) + um espaço FINAL
// que FECHA o token (não reabre o picker) e mantém a frase coerente. Antes o token era APAGADO — a citação
// sumia do prompt. Agora o anexo (`### Anexo: <mesmo caminho>`) casa 1:1 com esta referência inline, e o
// caminho relativo torna a citação de subdiretório inequívoca. Puro.
export function mentionInsertText(entry: WorkspaceEntry): string {
  return `@${entry.path}${entry.kind === "folder" ? "/" : ""} `;
}

// Separa o caminho relativo em prefixo de diretório (esmaecido na linha do picker) e basename (forte), para
// que citações em subdiretório fiquem legíveis e inequívocas. `dir` inclui a "/" final, ou "" na raiz. Puro.
export function splitMentionLabel(path: string): { dir: string; base: string } {
  const p = path ?? "";
  const i = p.lastIndexOf("/");
  return i === -1 ? { dir: "", base: p } : { dir: p.slice(0, i + 1), base: p.slice(i + 1) };
}

function isSubsequence(haystack: string, needle: string): boolean {
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j++) if (haystack[j] === needle[i]) i++;
  return i === needle.length;
}

// Casamento por SEGMENTO de caminho: cada parte de `q` (dividida por "/") aparece, em ordem, como substring
// de um segmento do path — `core/cont` casa `src/core/Controller.ts`. Deixa citar subdiretório digitando o
// caminho, mesmo sem o substring literal contíguo. Puro. (q e path já vêm em minúsculas do filterMentions.)
function segmentsMatch(path: string, q: string): boolean {
  const qs = q.split("/").filter(Boolean);
  const ps = path.split("/");
  let pi = 0;
  for (const seg of qs) {
    while (pi < ps.length && !ps[pi].includes(seg)) pi++;
    if (pi >= ps.length) return false;
    pi++;
  }
  return true;
}

// Filtra/ranqueia o catálogo do workspace pelo query. Prioriza: match exato do basename > basename começa >
// basename contém > caminho contém > subsequência (fuzzy). Empate: caminho mais curto, depois alfabético.
// Query vazio → os primeiros `limit` (o host já manda numa ordem estável). Puro.
export function filterMentions(items: WorkspaceEntry[], query: string, limit = 12): WorkspaceEntry[] {
  const q = (query ?? "").toLowerCase().trim();
  if (!q) return (items ?? []).slice(0, limit);
  const scored: { e: WorkspaceEntry; score: number }[] = [];
  for (const e of items ?? []) {
    const p = (e.path ?? "").toLowerCase();
    const base = p.split("/").pop() ?? p;
    let score = -1;
    if (base === q) score = 100;
    else if (base.startsWith(q)) score = 80;
    else if (base.includes(q)) score = 60;
    else if (p.includes(q)) score = 40;
    else if (q.includes("/") && segmentsMatch(p, q)) score = 30; // caminho digitado: `core/cont` → src/core/Controller.ts
    else if (isSubsequence(p, q)) score = 20;
    if (score >= 0) scored.push({ e, score });
  }
  scored.sort((a, b) => b.score - a.score || a.e.path.length - b.e.path.length || a.e.path.localeCompare(b.e.path));
  return scored.slice(0, limit).map((s) => s.e);
}
