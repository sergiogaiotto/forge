// Verificador de completude e costura de continuação — o núcleo da geração resiliente (zero arquivo
// truncado). Reaproveita o parser de cercas existente (parsePartialFileBlocks): um bloco forge-file
// cuja cerca de FECHAMENTO ainda não chegou é o sintoma direto de truncamento por limite de tokens.
import { ChatMessage } from "../api/types";
import { parsePartialFileBlocks } from "./fileBlocks";

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
    full = attempt === 0 ? res.text : stitchContinuation(full, res.text);
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
