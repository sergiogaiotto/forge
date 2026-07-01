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
const pathCount = (arr: unknown[]): number =>
  arr.filter((e) => e && typeof e === "object" && typeof (e as Record<string, unknown>).path === "string").length;
function extractBlueprintArray(raw: string): unknown[] | null {
  const text = raw.length > BP_MAX_INPUT ? raw.slice(0, BP_MAX_INPUT) : raw;
  let budget = BP_WORK_BUDGET;
  let best: unknown[] | null = null;
  let bestScore = 0;
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

// Reparo de TRUNCAMENTO (finish_reason=length): quando o raciocínio do gpt-oss consome o max_tokens,
// a resposta acaba NO MEIO do array (objeto/string cortados) e a extração balanceada falha — mas os
// objetos JÁ COMPLETOS são recuperáveis. Para cada '[' candidato que nunca fecha até o fim do texto,
// corta no último '}' que fecha um elemento DIRETO do array (nível 1) e fecha o colchete.
// Duas salvaguardas contra plano FALSO (confirmadas em revisão adversarial):
// 1) Só roda quando o chamador CONFIRMOU truncamento (finish_reason=length) E a extração normal falhou
//    — um eco de schema não fechado no raciocínio vazado, sem truncamento, deve continuar dando erro.
// 2) Entre candidatos reparáveis vence o MAIS TARDIO, não o de maior score: o corte por limite de
//    tokens é sempre no FIM do texto, logo o array da resposta final é o último '[' não fechado; um
//    rascunho vazado ANTERIOR (raciocínio) não pode vencer por ter mais objetos.
// Mesmo orçamento de trabalho da extração — nunca O(n²) que congele o host.
function salvageTruncatedArray(raw: string): unknown[] | null {
  const text = raw.length > BP_MAX_INPUT ? raw.slice(0, BP_MAX_INPUT) : raw;
  let budget = BP_WORK_BUDGET;
  let best: unknown[] | null = null;
  for (let i = 0; i < text.length && budget > 0; i++) {
    if (text[i] !== "[") continue;
    let depth = 0; // profundidade combinada de [ e { a partir deste candidato (1 = dentro do array)
    let inStr = false;
    let esc = false;
    let lastComplete = -1; // índice do '}' que devolve a profundidade a 1 = fechou um elemento do array
    let closed = false;
    for (let j = i; j < text.length; j++) {
      if (--budget <= 0) break;
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "[" || c === "{") depth++;
      else if (c === "]" || c === "}") {
        depth--;
        if (c === "}" && depth === 1) lastComplete = j;
        if (depth <= 0) {
          closed = true; // este candidato fecha sozinho — a extração normal já o considerou
          break;
        }
      }
    }
    if (closed || lastComplete < 0) continue;
    try {
      const arr = JSON.parse(text.slice(i, lastComplete + 1) + "]");
      // Candidato mais TARDIO vence (i crescente → a última atribuição fica): ver salvaguarda 2 acima.
      if (Array.isArray(arr) && pathCount(arr) > 0) best = arr;
    } catch {
      /* irreparável a partir deste '[' → tenta o próximo candidato */
    }
  }
  return best;
}

export interface ParseBlueprintOptions {
  // Habilita o reparo de array truncado. Passe true APENAS quando o stream terminou com
  // finish_reason=length — sem essa confirmação, o reparo poderia fabricar um plano a partir de um
  // eco de schema/rascunho não fechado no raciocínio vazado (resposta final sem array nenhum).
  salvageTruncated?: boolean;
}

export function parseBlueprint(text: string, opts?: ParseBlueprintOptions): BlueprintFile[] {
  // Remove o canal de análise/tokens harmony (vazamento do gpt-oss) e extrai o array top-level válido.
  // Último recurso — e só com truncamento confirmado: repara o array cortado pelo limite de tokens.
  const stripped = stripHarmony(text);
  let arr = extractBlueprintArray(stripped) ?? extractBlueprintArray(text);
  if (!arr && opts?.salvageTruncated) arr = salvageTruncatedArray(stripped) ?? salvageTruncatedArray(text);
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
