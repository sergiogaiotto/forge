// Verificador de completude e costura de continuação — o núcleo da geração resiliente (zero arquivo
// truncado). Reaproveita o parser de cercas existente (parsePartialFileBlocks): um bloco forge-file
// cuja cerca de FECHAMENTO ainda não chegou é o sintoma direto de truncamento por limite de tokens.
import { ChatMessage } from "../api/types";
import { FORGE_CELL_BLOCK_LANG, FORGE_FILE_BLOCK_LANG } from "../shared/protocol";
import { findOpeningFence } from "./fences";
import { parsePartialFileBlocks } from "./fileBlocks";
import { sanitizeHarmonyPreamble } from "./harmony";

// Omissões/elipses proibidas (espelham o NO_ELLIPSIS_RULE do systemPrompt): sinais fortes de que o
// modelo RESUMIU o arquivo em vez de emiti-lo inteiro. Conservador: exige a estrutura de PLACEHOLDER
// (reticências + termo de omissão qualificado por "código"/"arquivo"/etc.) para não marcar como
// incompleto um "..." ou "resto" legítimo em prosa/docstring/string.
const ELLIPSIS_PATTERNS: RegExp[] = [
  // "# ... (restante do código)", "// ... resto do arquivo", "-- ... demais métodos permanecem"
  /(^|\n)[ \t]*(#|\/\/|--)[ \t]*\.\.\.[ \t]*\(?[ \t]*(restante|resto|demais)\b[^\n]*\b(c[óo]digo|arquivo|m[ée]todo|classe|fun[çc][ãa]o|acima|igual|permanec|inalterad)/i,
  // "// ... existing code ...", "# ... rest of the code ..."
  /\.\.\.[ \t]*(existing|rest\s+of\s+(the\s+)?)\s*code[ \t]*\.\.\./i,
  // placeholders explícitos entre sinais de menor/maior
  /<[ \t]*(inalterado|unchanged|snip|\.\.\.)[ \t]*>/i,
];

// Uma linha "só cerca" (>=3 crases) no FIM do texto: o modelo TENTOU fechar (talvez com a contagem
// errada de crases). Isso é esquecimento de contagem, não truncamento — recoverOpen recupera no parse
// final, então NÃO vale re-pedir continuação.
const BARE_FENCE_TAIL = /(^|\n)`{3,}[ \t\r]*\n?[ \t]*$/;

export type IncompleteReason = "cerca-aberta" | "elipse";

export interface CompletenessResult {
  complete: boolean;
  reason?: IncompleteReason;
  path?: string; // arquivo afetado, quando identificável
}

// Juiz CONSERVADOR: só reprova em sinais FORTES de arquivo incompleto — um bloco forge-file cuja cerca
// de fechamento não chegou (truncamento), ou uma elipse/omissão explícita dentro de um bloco. NÃO tenta
// validar sintaxe da linguagem, para não gerar falso-negativo que levaria a um laço de continuação inútil.
export function checkCompleteness(text: string): CompletenessResult {
  const blocks = parsePartialFileBlocks(text);
  const open = blocks.find((b) => !b.closed);
  // Bloco sem fechamento exato, MAS o texto termina numa cerca solta → o modelo fechou com a contagem
  // errada (recoverOpen recupera). Não é truncamento: não vale continuar.
  if (open && !BARE_FENCE_TAIL.test(text)) return { complete: false, reason: "cerca-aberta", path: open.path || undefined };
  for (const b of blocks) {
    if (ELLIPSIS_PATTERNS.some((re) => re.test(b.content))) {
      return { complete: false, reason: "elipse", path: b.path || undefined };
    }
  }
  return { complete: true };
}

// Decide QUAL arquivo (se algum) marcar como PARCIAL após a geração resiliente. Recebe o texto COMPLETO
// para inspecionar o FECHAMENTO real de cada bloco (o discriminador confiável), pois `completeness`
// pode dizer `complete:true` mesmo com o último arquivo truncado — quando o modelo emite uma cerca solta
// de contagem ERRADA no fim, o BARE_FENCE_TAIL de checkCompleteness suprime o "cerca-aberta".
//
// Regras (só há parcial se o provider cortou):
//   (a) incompletude explícita (cerca aberta/elipse) → o arquivo afetado (`completeness.path`), ou, se o
//       corte veio antes do caminho, o ÚLTIMO bloco emitido.
//   (b) `complete:true` mas o provider cortou → é parcial APENAS se o ÚLTIMO bloco não fechou de fato
//       (truncamento no meio mascarado por cerca solta errada). Se todos fecharam, o corte foi ENTRE
//       arquivos: nenhum bloco COMPLETO é rebaixado (o que pode faltar são arquivos NÃO gerados). Isto
//       corrige o "Aplicar tudo" pular o README completo, sem deixar escapar um README truncado.
export function partialFilePath(
  wasTruncated: boolean,
  completeness: CompletenessResult,
  full: string
): string | undefined {
  if (!wasTruncated) return undefined;
  const blocks = parsePartialFileBlocks(full);
  if (!completeness.complete) {
    if (completeness.path && blocks.some((b) => b.path === completeness.path)) return completeness.path;
    return blocks[blocks.length - 1]?.path || undefined;
  }
  const last = blocks[blocks.length - 1];
  return last && !last.closed ? last.path || undefined : undefined;
}

// Fragmentos conversacionais que o modelo às vezes emite no INÍCIO de uma continuação, apesar de
// instruído a só continuar o código (ex.: "Will do.", "Add newline after fence.", "Vou continuar.").
// Se costurados crus, poluem o ARQUIVO. Padrões deliberadamente PROSA — o ramo continue/proceed exige
// prefixo conversacional ("vou continuar", "I'll continue"), nunca a keyword crua (que é código).
const CHAT_PREAMBLE: RegExp[] = [
  /^(sure|ok|okay|okey|understood|got it|will do|no problem|of course)[.!…]*$/i,
  /^(claro|certo|beleza|pronto|entendi|t[áa] bem|tudo bem|sem problema|combinado)[.!…]*$/i,
  // prefixo conversacional OBRIGATÓRIO — evita casar a keyword de controle de fluxo crua (continue/proceed…)
  /^(i'?ll |i will |let me |vou |deixa eu |irei |agora vou )(continu\w*|proceed\w*|prossegu\w*|resume|retomar|seguir)\b[^\n]*$/i,
  // formas de prosa em pt que não são keyword de código
  /^(continuando|prosseguindo|retomando|continua[çc][ãa]o)\b[^\n]*$/i,
  /^here('?s| is)( the)? (rest|remainder|continuation|code)\b[^\n]*$/i,
  /^(aqui (est[áa]|vai)|segue)( o| a)? ?(restante|resto|c[óo]digo|continua[çc][ãa]o)\b[^\n]*$/i,
  /^(add(ing)?|inserting|adicion(ando|o)?|inserindo)\b[^\n]*\b(new ?line|newline|nova linha|quebra de linha|fence|cerca)\b[^\n]*$/i,
  /^(closing|fechando|reopening|reabrindo)\b[^\n]*\b(fence|cerca|block|bloco)\b[^\n]*$/i,
  /^continuation\s*:?\s*$/i,
  // Marcador de canal harmony COLAPSADO (o gateway removeu os <|...|>) vazado como LINHA ISOLADA no
  // início de uma continuação do gpt-oss — ex.: "assistantfinal", "assistantanalysis". Não é código;
  // removido como preâmbulo. Os tokens delimitados (<|...|>) são tirados a montante por stripHarmonyTokens.
  /^assistant(final|analysis|commentary)$/i,
];

// Guarda de segurança: uma linha que "parece código" NUNCA é tratada como preâmbulo, mesmo que
// algum padrão a case. Bloqueia a corrupção silenciosa (ex.: apagar um `continue`/`break`/`proceed()`
// que retoma dentro de um laço truncado). Prosa não tem pontuação de código nem keyword de fluxo.
function looksLikeCode(t: string): boolean {
  if (/[=;(){}\[\]<>]/.test(t)) return true; // atribuição, chamada, bloco, ponto-e-vírgula
  if (/^(continue|break|pass|return|next|done|do|then|else|elif|fi|esac|end|yield|await|raise|throw|goto)\b/i.test(t)) return true;
  return false;
}

// Remove um preâmbulo conversacional do INÍCIO de uma continuação. Só corta uma linha que casa
// CHAT_PREAMBLE e NÃO parece código; linhas em branco contam apenas como "ponte" entre preâmbulos
// (não são removidas por si sós — preserva linha em branco separadora legítima). Para na primeira
// linha de código. Conservador e limitado às primeiras linhas (cap): nunca remove código.
export function sanitizeContinuation(cont: string): string {
  if (!cont) return cont;
  const lines = cont.split("\n");
  const cap = Math.min(lines.length, 8);
  let cut = 0; // até onde já confirmamos remoção (exclusivo)
  let j = 0;
  while (j < cap) {
    const t = lines[j].trim();
    if (t === "") {
      j++; // branco é ponte — só vira remoção se um preâmbulo o suceder
      continue;
    }
    if (!looksLikeCode(t) && CHAT_PREAMBLE.some((re) => re.test(t))) {
      j++;
      cut = j; // confirma o corte até aqui (inclui brancos-ponte anteriores)
      continue;
    }
    break; // primeira linha de código/prosa desconhecida → para
  }
  return cut === 0 ? cont : lines.slice(cut).join("\n");
}

// Costura a continuação ao texto acumulado removendo a SOBREPOSIÇÃO: a continuação quase sempre repete
// um pedaço do fim do trecho anterior. Acha o maior sufixo de `prev` que também é prefixo de `cont`
// (até 400 chars) e concatena sem duplicar. Sem overlap claro, concatena direto. O piso de 12 chars
// evita casar por coincidência trechos curtos comuns (ex.: uma quebra de linha + indentação).
export function stitchContinuation(prev: string, cont: string): string {
  if (!prev) return cont;
  if (!cont) return prev;
  const maxK = Math.min(prev.length, cont.length, 400);
  for (let k = maxK; k >= 12; k--) {
    if (prev.slice(prev.length - k) === cont.slice(0, k)) {
      return prev + cont.slice(k);
    }
  }
  return prev + cont;
}

// Índice de início da 1ª cerca de bloco forge-file OU forge-cell no texto; -1 se não houver. Delimita o
// PREÂMBULO (prosa antes do 1º bloco, onde o vazamento de análise do gpt-oss aparece) do PAYLOAD (o
// conteúdo dos arquivos, que fica VERBATIM — pode conter literais harmony no domínio do FORGE).
function firstBlockFence(text: string): number {
  const f = findOpeningFence(text, FORGE_FILE_BLOCK_LANG, 0);
  const c = findOpeningFence(text, FORGE_CELL_BLOCK_LANG, 0);
  const starts = [f?.start, c?.start].filter((n): n is number => typeof n === "number");
  return starts.length ? Math.min(...starts) : -1;
}

// Saneia SÓ o preâmbulo (antes do 1º bloco); o payload fica intocado. `cleanWholeIfNoBlock`: numa 1ª
// passagem sem bloco o texto é PROSA (saneia tudo); numa CONTINUAÇÃO sem bloco o texto é a retomada de um
// arquivo aberto — CÓDIGO PURO — e NÃO pode ser tocado (senão um `<|…|>`/`assistantfinal` literal do
// código seria destruído — achado crítico da revisão). Cerca no char 0 = sem preâmbulo → intocado.
function sanitizeLead(text: string, cleanWholeIfNoBlock: boolean): string {
  const b = firstBlockFence(text);
  if (b < 0) return cleanWholeIfNoBlock ? sanitizeHarmonyPreamble(text) : text;
  if (b === 0) return text;
  return sanitizeHarmonyPreamble(text.slice(0, b)) + text.slice(b);
}

export interface ResilientOptions {
  maxContinuations: number;
  anchorChars: number; // quanto da CAUDA do texto reenviar como âncora na continuação (não o todo)
  buildContinuation: (path: string | undefined) => string; // continuar um arquivo cortado (cerca aberta)
  buildTailContinuation: () => string; // continuar a resposta cortada ENTRE blocos (ex.: faltam arquivos)
  onContinue?: (attempt: number, path: string | undefined) => void;
  aborted?: () => boolean;
}

export interface ResilientResult {
  full: string;
  completeness: CompletenessResult;
  attempts: number; // nº de continuações efetuadas
  truncated: boolean; // ao final, ainda estava cortado (cerca aberta OU provider sinalizou o corte)
  error?: string;
}

// Laço de geração resiliente (puro e testável, sem dependência de vscode): executa uma passagem via
// `streamFn`, verifica a completude, e enquanto houver TRUNCAMENTO — cerca de arquivo aberta OU o provider
// tendo sinalizado corte por limite de tokens (res.truncated, cobre o corte ENTRE arquivos numa geração
// multi-arquivo) — dentro do teto, sem stall e sem abort, re-pede a continuação reenviando só a CAUDA do
// texto como âncora e costura ao acumulado. Sem o sinal do provider, um corte na fronteira entre blocos
// passaria despercebido (todos os blocos "fechados") e entregaria um projeto incompleto como sucesso.
export async function resilientGenerate(
  baseMessages: ChatMessage[],
  streamFn: (messages: ChatMessage[]) => Promise<{ text: string; error?: string; truncated?: boolean }>,
  opts: ResilientOptions
): Promise<ResilientResult> {
  let full = "";
  let attempt = 0;
  let completeness: CompletenessResult = { complete: true };
  let convo = baseMessages;
  for (;;) {
    const res = await streamFn(convo);
    if (res.error !== undefined) return { full, completeness, attempts: attempt, truncated: false, error: res.error };
    const before = full.length;
    // Saneamento harmony do PREÂMBULO (rede de segurança do gpt-oss em STREAMING — o canal de análise às
    // vezes vaza no content antes do conteúdo; o blueprint roda em não-streaming e já é imune, a geração de
    // código é streaming pela UX arquivo-a-arquivo). Só a prosa ANTES do 1º bloco é saneada; o CONTEÚDO dos
    // arquivos fica VERBATIM (pode conter `assistantfinal`/`<|…|>` como literal — domínio do FORGE). Round 0
    // sem bloco = prosa (saneia); continuação sem bloco = retomada de código (intocada). Per-PARTE.
    const part = sanitizeLead(res.text, attempt === 0);
    full = attempt === 0 ? part : stitchContinuation(full, sanitizeContinuation(part));
    completeness = checkCompleteness(full);
    const openFence = !completeness.complete && completeness.reason === "cerca-aberta";
    const incomplete = openFence || res.truncated === true; // provider cortou (mesmo entre blocos fechados)
    const stalled = attempt > 0 && full.length <= before; // a continuação não avançou → não insista
    if (!incomplete) return { full, completeness, attempts: attempt, truncated: false };
    if (attempt >= opts.maxContinuations || stalled || opts.aborted?.()) {
      return { full, completeness, attempts: attempt, truncated: true }; // esgotou ainda cortado
    }
    attempt++;
    opts.onContinue?.(attempt, completeness.path);
    const anchor = full.length > opts.anchorChars ? full.slice(-opts.anchorChars) : full;
    // cerca aberta → continuar o MESMO arquivo; corte entre blocos → continuar a resposta (próximos arquivos).
    const instruction = openFence ? opts.buildContinuation(completeness.path) : opts.buildTailContinuation();
    convo = [...baseMessages, { role: "assistant", content: anchor }, { role: "user", content: instruction }];
  }
}
