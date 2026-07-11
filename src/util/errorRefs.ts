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
