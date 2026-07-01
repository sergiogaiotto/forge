// Blueprint do Modo Projeto (Fase F): o plano de arquivos aprovável ANTES de gerar código. O modelo
// devolve um array JSON de {path, purpose, deps}; este parser é TOLERANTE (extrai o primeiro array
// JSON top-level válido do texto, mesmo cercado por prosa/```json/raciocínio vazado) e normaliza.
// Puro/testável.
import type { BlueprintFile } from "../shared/protocol";
import { stripHarmony } from "./harmony";
import { isSafeRelPath } from "./safePath";

// Encontra o array JSON top-level BALANCEADO que MAIS PARECE um blueprint. Varre cada '[' candidato,
// balanceando colchetes e respeitando strings/escapes — imune a colchetes na prosa/raciocínio, arrays de
// exemplo (["a","b"]) e um ']' extra depois do array real. Escolhe o candidato com MAIS objetos-com-path
// (o blueprint real tem vários arquivos; um schema-echo de exemplo tem 1-2); empate → o mais TARDIO (a
// resposta final vem por último). Limitado por um ORÇAMENTO de trabalho + teto de entrada para nunca
// virar O(n²) que congele o host quando o raciocínio vazado é grande e cheio de '['.
const BP_MAX_INPUT = 1_000_000; // saída de blueprint plausível cabe folgada; além disso é ruído
const BP_WORK_BUDGET = 3_000_000; // teto de char-visitas na varredura balanceada (poucos ms)
function extractBlueprintArray(raw: string): unknown[] | null {
  const text = raw.length > BP_MAX_INPUT ? raw.slice(0, BP_MAX_INPUT) : raw;
  let budget = BP_WORK_BUDGET;
  let best: unknown[] | null = null;
  let bestScore = 0;
  const pathCount = (arr: unknown[]): number =>
    arr.filter((e) => e && typeof e === "object" && typeof (e as Record<string, unknown>).path === "string").length;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "[") continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < text.length; j++) {
      if (--budget <= 0) return best; // esgotou o orçamento → devolve o melhor encontrado (segurança)
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "[") depth++;
      else if (c === "]") {
        depth--;
        if (depth === 0) {
          try {
            const arr = JSON.parse(text.slice(i, j + 1));
            if (Array.isArray(arr)) {
              const score = pathCount(arr);
              if (score > 0 && score >= bestScore) {
                best = arr; // >= prefere o candidato mais tardio no empate (a resposta final vem por último)
                bestScore = score;
              }
            }
          } catch {
            /* esse '[' não fechou num array válido → tenta o próximo candidato */
          }
          break;
        }
      }
    }
  }
  return best;
}

export function parseBlueprint(text: string): BlueprintFile[] {
  // Remove o canal de análise/tokens harmony (vazamento do gpt-oss) e extrai o array top-level válido.
  const arr = extractBlueprintArray(stripHarmony(text)) ?? extractBlueprintArray(text);
  if (!arr) return [];
  const seen = new Set<string>();
  const out: BlueprintFile[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const f = raw as Record<string, unknown>;
    const path = String(f.path ?? "").trim().replace(/^[./\\]+/, ""); // sem ./ ou / inicial
    // Descarta caminhos que escapariam o workspace (`..` interior, absoluto, drive/UNC) — o path vem do modelo.
    if (!path || seen.has(path) || !isSafeRelPath(path)) continue;
    seen.add(path);
    out.push({
      path,
      purpose: String(f.purpose ?? "").trim().slice(0, 200),
      deps: Array.isArray(f.deps) ? f.deps.map((d) => String(d).trim()).filter(Boolean).slice(0, 20) : [],
    });
  }
  return out;
}

// Ordena os arquivos em ordem topológica pelas dependências declaradas (deps antes dos dependentes).
// Estável e tolerante a ciclos/deps desconhecidas (mantém a ordem original como desempate). Usada para
// gerar/aplicar na ordem certa (interfaces → domínio → adapters → wiring → testes).
export function topoSort(files: BlueprintFile[]): BlueprintFile[] {
  const byPath = new Map(files.map((f, i) => [f.path, i]));
  const visited = new Set<string>();
  const temp = new Set<string>();
  const order: BlueprintFile[] = [];
  const visit = (f: BlueprintFile) => {
    if (visited.has(f.path) || temp.has(f.path)) return; // ciclo → corta
    temp.add(f.path);
    for (const d of f.deps) {
      const idx = byPath.get(d);
      if (idx !== undefined) visit(files[idx]);
    }
    temp.delete(f.path);
    visited.add(f.path);
    order.push(f);
  };
  for (const f of files) visit(f);
  return order;
}
