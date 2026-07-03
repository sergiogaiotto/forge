// Blueprint do Modo Projeto (Fase F): o plano de arquivos aprovável ANTES de gerar código. O modelo
// devolve um array JSON de {path, purpose, deps}; este parser é TOLERANTE (extrai o primeiro array
// JSON top-level válido do texto, mesmo cercado por prosa/```json/raciocínio vazado) e normaliza.
// Puro/testável.
import type { BlueprintFile } from "../shared/protocol";
import { extractFinalChannel, stripHarmony } from "./harmony";
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
interface ExtractOptions {
  // Seleção pelo candidato mais TARDIO que qualifica (em vez do de maior score). Usado no resgate
  // do CoT bruto: o plano FINAL é o último array que o modelo escreveu — um rascunho anterior maior
  // não pode vencer a revisão-para-baixo (confirmado em revisão adversarial).
  preferLatest?: boolean;
  // Score mínimo (nº de objetos-com-path) para um candidato QUALIFICAR. Com preferLatest, impede
  // que um eco de schema (1 objeto) DEPOIS do plano real roube a seleção.
  minFiles?: number;
}

function extractBlueprintArray(raw: string, opts: ExtractOptions = {}): unknown[] | null {
  const text = raw.length > BP_MAX_INPUT ? raw.slice(0, BP_MAX_INPUT) : raw;
  let budget = BP_WORK_BUDGET;
  let best: unknown[] | null = null;
  let bestScore = 0;
  const minScore = Math.max(1, opts.minFiles ?? 1);
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
              // Default: maior score vence; >= prefere o mais tardio no empate (a resposta final vem
              // por último). preferLatest: QUALQUER candidato qualificado mais tardio substitui.
              if (score >= minScore && (opts.preferLatest || score >= bestScore)) {
                best = arr;
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
  // Seleção por posição (mais tardio qualificado vence) + piso de qualificação — ver ExtractOptions.
  preferLatest?: boolean;
  minFiles?: number;
}

export function parseBlueprint(text: string, opts?: ParseBlueprintOptions): BlueprintFile[] {
  // Remove o canal de análise/tokens harmony (vazamento do gpt-oss) e extrai o array top-level válido.
  // Último recurso — e só com truncamento confirmado: repara o array cortado pelo limite de tokens.
  const extract: ExtractOptions = { preferLatest: opts?.preferLatest, minFiles: opts?.minFiles };
  const stripped = stripHarmony(text);
  let arr = extractBlueprintArray(stripped, extract) ?? extractBlueprintArray(text, extract);
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

// Um projeto COMPLETO tem sempre >=2 arquivos (manifesto + código + README no mínimo). Um "plano" de
// 1 arquivo é quase certamente eco do exemplo do system prompt ou fragmento de rascunho — tratá-lo
// como inválido dispara a 2ª tentativa (conversão), que produz o plano real.
export const MIN_BLUEPRINT_FILES = 2;

// Escolhe o plano entre os CANAIS de uma resposta de modelo de raciocínio, na ordem de confiança:
// 1) content — parser tolerante (reparo de truncamento gated por finish_reason=length);
// 2) canal de raciocínio — SÓ o conteúdo após o marcador do canal final (extractFinalChannel).
//    O raciocínio BRUTO ecoa o schema/rascunhos do system prompt: parseá-lo fabricaria um plano
//    falso e PULARIA a 2ª tentativa de conversão (confirmado em revisão adversarial). Sem marcador,
//    o raciocínio vai para a 2ª tentativa como matéria-prima da conversão — não para o parser;
// 3) ÚLTIMO recurso, só com content totalmente VAZIO: extração ESTRITA do raciocínio bruto (sem
//    reparo de truncamento — rascunho não fechado nunca vira plano). O piso de MIN_BLUEPRINT_FILES
//    bloqueia o eco de schema (1 objeto); um array completo de vários arquivos no CoT é o plano que
//    o modelo redigiu e o gateway não roteou — vai para a aprovação humana em vez de falhar seco.
// Plano com menos de MIN_BLUEPRINT_FILES é inválido ([]) — deixa o chamador escalar/errar com clareza.
export function pickBlueprintFromChannels(a: { text: string; reasoning: string; truncated: boolean }): {
  files: BlueprintFile[];
  fromReasoning: boolean;
  salvaged: boolean;
} {
  let files = parseBlueprint(a.text, { salvageTruncated: a.truncated });
  let fromReasoning = false;
  let salvaged = false;
  // Reparo SEM sinal de truncamento (caso real de campo: o stream termina "limpo" com
  // finish_reason=stop mas o array veio cortado no meio — sem o sinal `length` o reparo ficava
  // desligado e um plano com N objetos completos era jogado fora). Seguro AGORA porque: o piso
  // MIN_BLUEPRINT_FILES barra o eco de schema (1 objeto), o próprio reparo é latest-wins (rascunho
  // anterior não vence) e o plano vai à APROVAÇÃO humana com aviso de "plano parcial" no modal.
  if (files.length < MIN_BLUEPRINT_FILES && !a.truncated && a.text.trim()) {
    // minFiles no resgate: um eco de schema FECHADO (1 objeto) antes do plano cortado satisfaria a
    // extração normal e BLOQUEARIA o reparo (o salvage só roda quando a extração falha). Com o piso,
    // arrays fechados sub-piso são ignorados e o reparo alcança o plano real — seguro: qualquer
    // array fechado com >=2 já teria sido tomado pelo primeiro parse acima.
    const rescued = parseBlueprint(a.text, { salvageTruncated: true, minFiles: MIN_BLUEPRINT_FILES });
    if (rescued.length >= MIN_BLUEPRINT_FILES) {
      files = rescued;
      salvaged = true;
    }
  }
  if (files.length < MIN_BLUEPRINT_FILES && a.reasoning.trim()) {
    const final = extractFinalChannel(a.reasoning);
    if (final) {
      const rescued = parseBlueprint(final, { salvageTruncated: a.truncated });
      if (rescued.length > files.length) {
        files = rescued;
        fromReasoning = true;
      }
    } else if (!a.text.trim()) {
      // content VAZIO e sem marcador de canal final: gateway roteou tudo para reasoning_content.
      // Extração estrita (arrays completos apenas), pelo candidato mais TARDIO qualificado: o plano
      // FINAL é o último que o modelo escreveu — um rascunho anterior maior não vence a revisão-para-
      // baixo, e o piso >=2 impede que um eco de schema (1 objeto) após o plano roube a seleção.
      const rescued = parseBlueprint(a.reasoning, { preferLatest: true, minFiles: MIN_BLUEPRINT_FILES });
      if (rescued.length >= MIN_BLUEPRINT_FILES) {
        files = rescued;
        fromReasoning = true;
      }
    }
  }
  if (files.length < MIN_BLUEPRINT_FILES) return { files: [], fromReasoning: false, salvaged: false };
  return { files, fromReasoning, salvaged };
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
