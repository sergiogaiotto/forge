// Verificador de completude e costura de continuação — o núcleo da geração resiliente (zero arquivo
// truncado). Reaproveita o parser de cercas existente (parsePartialFileBlocks): um bloco forge-file
// cuja cerca de FECHAMENTO ainda não chegou é o sintoma direto de truncamento por limite de tokens.
import { ChatMessage } from "../api/types";
import { FORGE_CELL_BLOCK_LANG, FORGE_FILE_BLOCK_LANG } from "../shared/protocol";
import { findOpeningFence } from "./fences";
import { FileBlock, parseFileBlocks, parsePartialFileBlocks } from "./fileBlocks";
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

// Quantas rodadas CONSECUTIVAS sem PROGRESSO real antes de desistir (F-02). Uma única continuação azarada
// (resposta vazia, ou uma re-emissão que não avança o plano) NÃO pode abandonar um projeto quase completo:
// toleramos 1 rodada morta e desistimos só na 2ª seguida. O teto rígido (maxContinuations) e o abort
// continuam curto-circuitando. "Progresso" é o conjunto de arquivos do plano ENCOLHER (não só o texto
// crescer) — ver resilientGenerate: no Modo Projeto o modelo às vezes re-emite um arquivo já feito, que
// infla o texto SEM emitir o que falta (progresso falso).
const STALL_TOLERANCE = 2;

// openFence "spin" (Modo Projeto): o gpt-oss às vezes TRAVA fechando a cerca de UM arquivo — vaza fragmentos
// de raciocínio/confusão de fence ("Proceed.", "Thus final.") a cada continuação SEM fechar a cerca. O laço
// então queima TODAS as continuações nesse arquivo, sem alcançar o resto do plano (achado empírico ao vivo:
// 1/48, 38/48). Defesa: contar rodadas de continuação CONSECUTIVAS com o MESMO arquivo aberto; ao atingir o
// teto — OU quando a guarda de stall dispara nele — ABANDONA o arquivo (marca parcial) e faz clean-room do
// resto. O teto é ALTO o bastante para não abandonar um arquivo grande legítimo (que fecha em poucas rodadas):
// medido ao vivo, um arquivo legítimo fecha em ≤4 continuações; um spin não fecha em 6-7. (NÃO se usa piso de
// crescimento: o spin real cresce bastante — "cresceu pouco" não distingue spin de arquivo grande; só "não
// fecha há K rodadas" distingue.)
const STUCK_FILE_TOLERANCE = 5; // continuações seguidas presas no mesmo arquivo aberto → abandona e salva o resto

// Teto de continuações da geração resiliente. Modo Projeto (há plano/expectedPaths) usa o teto MAIOR para
// FINANCIAR o salvamento da clean-room quando o modelo trava num arquivo (openFence spin); chat/TDD usam o
// padrão. Exportados/puros para serem testáveis — o Task NÃO é importável em teste (puxa vscode via logger).
export const MAX_CONTINUATIONS = 6;
export const PROJECT_MAX_CONTINUATIONS = 14;
export function pickMaxContinuations(expectedPaths: string[] | undefined): number {
  return (expectedPaths?.length ?? 0) > 0 ? PROJECT_MAX_CONTINUATIONS : MAX_CONTINUATIONS;
}

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

// Conjunto de paths (NORMALIZADOS) que Task.run deve marcar como PARCIAL: o arquivo cortado do partialFilePath
// (o último bloco aberto) MAIS os arquivos ABANDONADOS pelo laço (openFence spin salvo). Puro/testável — o
// Task não tem harness de teste, e o abandonado é o ÚNICO ponto de integridade do fix do spin. NÃO cruza com
// closedBlockPaths (o scanner de streaming "fecha" o abandonado emprestando a cerca do bloco seguinte —
// reportaria o cortado como fechado e o deixaria escapar; achado CRÍTICO da revisão adversarial). Marcar um
// abandonado como parcial é sempre o lado SEGURO: o laço só o inclui quando tem corpo truncado e NUNCA o
// re-pede — então nem chega a ser re-emitido fechado; e se um modelo desobediente o re-emitisse, pular o
// Aplicar + avisar é melhor que gravar um arquivo possivelmente cortado.
export function partialProposalKeys(
  wasTruncated: boolean,
  completeness: CompletenessResult,
  full: string,
  abandonedPaths: string[] | undefined
): Set<string> {
  const keys = new Set<string>();
  const p = partialFilePath(wasTruncated, completeness, full);
  if (p) keys.add(normResilientPath(p));
  for (const a of abandonedPaths ?? []) keys.add(normResilientPath(a));
  return keys;
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
  // Emenda de CERCAS (achado ao vivo no rig MDM): quando a continuação COMEÇA com uma cerca de
  // ABERTURA de bloco (````forge-file/forge-cell — caso típico do clean-room e da continuação de
  // cauda) e o acumulado NÃO termina em quebra de linha (o modelo pode terminar a parte anterior
  // exatamente no ```` de fechamento, sem \n), a concatenação direta funde fechamento+abertura numa
  // única linha de 8+ backticks. O parser então exige cerca >= 8 para fechar e ENGOLE os blocos
  // seguintes DENTRO do arquivo anterior — aplicado corrompido, sem flag de parcial. O "\n" aqui é
  // seguro: cerca de abertura só tem efeito no início de linha, e a retomada mid-line de arquivo
  // cortado nunca começa com cerca de abertura legítima colada à linha anterior.
  if (!prev.endsWith("\n") && OPENING_FENCE_AT_START.test(cont)) {
    return prev + "\n" + cont;
  }
  return prev + cont;
}

// Cerca de abertura de bloco forge no INÍCIO da continuação (3+ backticks + linguagem do protocolo).
const OPENING_FENCE_AT_START = new RegExp(`^\`{3,}(?:${FORGE_FILE_BLOCK_LANG}|${FORGE_CELL_BLOCK_LANG})\\b`);

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
  buildTailContinuation: (missing?: string[]) => string; // continuar a resposta cortada ENTRE blocos (ex.: faltam arquivos)
  // Modo Projeto (clean-room, F-02): faltam arquivos do PLANO e o último bloco NÃO ficou aberto → pede os
  // faltantes NOMEADOS como blocos NOVOS e completos, numa conversa LIMPA — SEM reenviar a âncora da cauda.
  // A âncora estagnava o laço: o modelo re-emitia a cauda, o stitch dedupava, crescimento zero → stall.
  // O plano + propósitos vivem no system prompt (constante em toda chamada), então a âncora não é sinal de
  // retomada aqui — só um ímã de re-emissão. Ausente ⇒ mantém o caminho ancorado antigo (compat de teste).
  // `emitted` = os blocos que ESTA geração já produziu (o CONTRATO real), p/ o builder mostrar as assinaturas
  // concretas e o modelo NÃO regenerar os faltantes CEGO (R5 — o plano no system prompt não tem as assinaturas).
  buildMissingFilesContinuation?: (missing: string[], emitted: FileBlock[]) => string;
  // Modo Projeto: os caminhos ESPERADOS do blueprint. Enquanto algum não tiver sido emitido como bloco
  // FECHADO, a geração NÃO está completa — mesmo sem cerca aberta e sem o provider sinalizar corte (o
  // gpt-oss às vezes auto-encerra a cauda com arquivos faltando). A continuação NOMEIA os que faltam. (F-02)
  expectedPaths?: string[];
  onContinue?: (attempt: number, path: string | undefined) => void;
  aborted?: () => boolean;
}

export interface ResilientResult {
  full: string;
  completeness: CompletenessResult;
  attempts: number; // nº de continuações efetuadas
  truncated: boolean; // ao final, ainda estava cortado (cerca aberta OU provider sinalizou o corte)
  // Arquivos ABANDONADOS pelo laço (openFence spin: o modelo travou fechando-os — salvamos o RESTO do plano
  // via clean-room). INDEPENDENTE de `truncated` (no salvamento bem-sucedido truncated=false): depois que um
  // bloco fechado sucede o abandonado, o scanner o lê como "fechado" e o partialFilePath não o pega — então
  // Task.run usa ESTE campo para marcá-lo PARCIAL (senão o arquivo cortado seria aplicado como completo).
  abandonedPaths?: string[];
  error?: string;
}

// Normaliza caminho para casar o path do blueprint com o `path=` emitido: separadores/`./` divergem, e a
// caixa também — o FS do dev costuma ser case-insensitive e um eco com caixa diferente não deve virar
// falso-faltante e queimar continuações. (Ser leniente aqui só reduz continuações espúrias.)
export function normResilientPath(p: string): string {
  return p.replace(/^[.\/\\]+/, "").replace(/\\/g, "/").toLowerCase();
}
// Arquivos do plano (expectedPaths) que AINDA não foram emitidos. Usa o parser AUTORITATIVO — parseFileBlocks,
// o MESMO que vira proposta aplicável e que RECUPERA um bloco com a cerca mal-contada (recoverOpen) — e não
// closedBlockPaths (scanner de streaming, que exige o nº de crases EXATO no fechamento). Senão um arquivo do
// plano emitido POR INTEIRO mas fechado com crases a menos seria falso-faltante e dispararia continuação
// espúria (+ proposta duplicada, + aviso de truncamento falso) — reintroduzindo, só no Modo Projeto, a
// falsa-continuação que o BARE_FENCE_TAIL/recoverOpen existem para evitar. (Achado da revisão adversarial.)
export function missingExpectedFiles(full: string, expected: string[] | undefined): string[] {
  if (!expected || expected.length === 0) return [];
  const emitted = new Set(parseFileBlocks(full).map((b) => normResilientPath(b.path)));
  return expected.filter((p) => !emitted.has(normResilientPath(p)));
}

// R5: os blocos JÁ EMITIDOS por esta geração (o CONTRATO real) para a continuação clean-room mostrar as
// assinaturas concretas ao modelo — senão ele regenera os faltantes CEGO ao que já escreveu (drift/símbolo
// fantasma). Dedupa por path e EXCLUI o bloco ABERTO (o arquivo travado/abandonado, ainda incompleto — não é
// contrato confiável). Usa parseFileBlocks (AUTORITATIVO, recupera cerca mal-contada), como missingExpectedFiles.
export function emittedContracts(full: string, openPath: string | undefined): FileBlock[] {
  const open = openPath ? normResilientPath(openPath) : "";
  return dedupeFileBlocksByPath(parseFileBlocks(full), openPath).filter((b) => normResilientPath(b.path) !== open);
}

// Colapsa blocos com o MESMO path (o modelo às vezes re-emite um arquivo já gerado numa continuação
// clean-room — não vê o que já escreveu). Sem isto, dois `path=X` no texto virariam dois cartões e o
// "Aplicar tudo" poderia sobrescrever o arquivo bom com a re-emissão cortada. Regra: prefere o bloco
// FECHADO ao ABERTO/truncado (senão uma re-emissão cortada porém MAIOR venceria a cópia completa e mais
// curta — achado da revisão); entre blocos de mesma completude, MAIOR-CONTEÚDO-VENCE (ordem-independente:
// mantém a cópia completa venha primeiro ou depois). O bloco aberto só pode ser o ÚLTIMO do texto (uma
// cerca aberta engole o resto), e `openPath` (= completeness.path da cerca-aberta) o identifica — daí o
// discriminador de completude NÃO cruzar com o `.closed` do parsePartialFileBlocks (que reintroduziria a
// armadilha #158). Opera sobre parseFileBlocks (AUTORITATIVO — recupera cerca mal-contada via recoverOpen).
// Preserva a ordem da 1ª ocorrência (a ordem topológica dos cartões).
export function dedupeFileBlocksByPath(blocks: FileBlock[], openPath?: string): FileBlock[] {
  const best = new Map<string, { block: FileBlock; open: boolean }>();
  const order: string[] = [];
  const openKey = openPath && openPath.length > 0 ? normResilientPath(openPath) : undefined;
  const lastIdx = blocks.length - 1;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const key = normResilientPath(b.path);
    const open = openKey !== undefined && i === lastIdx && key === openKey; // só o último bloco pode estar aberto
    const prev = best.get(key);
    if (!prev) {
      best.set(key, { block: b, open });
      order.push(key);
    } else if ((prev.open && !open) || (prev.open === open && b.content.length > prev.block.content.length)) {
      best.set(key, { block: b, open }); // fechado > aberto; entre iguais, maior-conteúdo-vence
    }
  }
  return order.map((k) => best.get(k)!.block);
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
  let noProgress = 0; // rodadas consecutivas SEM progresso real (F-02: quebra o stall da cauda estagnada)
  let prevMissingCount = Number.POSITIVE_INFINITY; // arquivos do plano faltando na rodada anterior
  let prevOpenFence = false; // a rodada anterior terminou com um arquivo aberto (cortado no meio)?
  let stuckPath: string | undefined; // arquivo atualmente "travado" aberto (openFence spin) — chaveia o streak
  let stuckStreak = 0; // rodadas de continuação seguidas com o MESMO arquivo travado crescendo < o piso
  const abandonedPaths: string[] = []; // arquivos abandonados (travados) — salvamos o resto do plano
  let completeness: CompletenessResult = { complete: true };
  let convo = baseMessages;
  for (;;) {
    const res = await streamFn(convo);
    if (res.error !== undefined) return { full, completeness, attempts: attempt, truncated: false, abandonedPaths, error: res.error };
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
    // Modo Projeto: arquivos do plano ainda NÃO emitidos ⇒ incompleto, mesmo sem cerca aberta e sem o
    // provider sinalizar corte (o gpt-oss auto-encerra a cauda com arquivos faltando — achado F-02).
    const missing = missingExpectedFiles(full, opts.expectedPaths);
    const incomplete = openFence || res.truncated === true || missing.length > 0;
    // PROGRESSO real (não só "cresceu"): no Modo Projeto, enquanto AINDA faltam arquivos do plano, o sinal
    // autoritativo é o conjunto faltante ENCOLHER — ou um arquivo aberto avançar/fechar. Um arquivo do plano
    // cortado no meio já conta como "emitido" (recoverOpen o recupera assim que tem corpo), então FECHÁ-LO numa
    // rodada seguinte não muda `missing`; sem creditar essa transição (aberto→fechado) o fechamento seria lido
    // como rodada morta e queimaria uma folga do stall bem no regime-alvo do F-02. Uma continuação clean-room
    // às vezes re-emite um arquivo JÁ feito: o texto cresce sem emitir o que falta (progresso FALSO), e "cresceu"
    // sozinho mascararia o stall. Sem plano (chat)/plano completo, o sinal é o texto crescer. Reseta a cada
    // progresso; some por STALL_TOLERANCE rodadas seguidas → desiste.
    const grew = full.length > before;
    const hasPlan = (opts.expectedPaths?.length ?? 0) > 0;
    const closedAnOpenFile = prevOpenFence && !openFence && grew; // fechou o arquivo que estava aberto
    const madeProgress =
      attempt === 0 ||
      (hasPlan && missing.length > 0
        ? missing.length < prevMissingCount || (openFence && grew) || closedAnOpenFile
        : grew);
    noProgress = madeProgress ? 0 : noProgress + 1;
    prevMissingCount = missing.length;
    prevOpenFence = openFence;
    // openFence "spin": conta rodadas de CONTINUAÇÃO (attempt>0 — a emissão inicial não é "travamento") em que
    // o MESMO arquivo segue aberto. Chaveia por completeness.path (o 1º bloco não fechado) — X-fecha/Y-abre
    // reseta. SEM piso de crescimento: o spin REAL do gpt-oss cresce bastante (não é fragmento minúsculo),
    // então "cresceu pouco" NÃO distingue spin de arquivo grande legítimo — só "não fecha há K rodadas"
    // distingue (o legítimo fecha; comprovado ao vivo). Um arquivo que fecha antes de K nunca é abandonado.
    const onOpenPath = openFence && completeness.path !== undefined;
    stuckStreak = attempt > 0 && onOpenPath && completeness.path === stuckPath ? stuckStreak + 1 : 0;
    stuckPath = onOpenPath ? completeness.path : undefined;
    const stalled = noProgress >= STALL_TOLERANCE;
    // SALVAMENTO: estamos travados num arquivo aberto (por STALL ou por K rodadas presas nele), HÁ OUTROS
    // arquivos do plano a salvar e temos o builder da clean-room → abandona o travado e emite o RESTO. Precede
    // a desistência por stall (senão o spin de baixo-crescimento morreria no stall antes de salvar o plano).
    const canSalvage =
      openFence && missing.length > 0 && !!opts.buildMissingFilesContinuation && (stalled || stuckStreak >= STUCK_FILE_TOLERANCE);
    if (!incomplete) return { full, completeness, attempts: attempt, truncated: false, abandonedPaths };
    // Limites DUROS (teto/abort) sempre param. A desistência por STALL é PULADA quando dá para salvar o resto.
    if (attempt >= opts.maxContinuations || opts.aborted?.()) {
      return { full, completeness, attempts: attempt, truncated: true, abandonedPaths };
    }
    if (stalled && !canSalvage) {
      return { full, completeness, attempts: attempt, truncated: true, abandonedPaths }; // travou sem o que salvar
    }
    attempt++;
    opts.onContinue?.(attempt, completeness.path);
    if (canSalvage) {
      // ABANDONA o arquivo travado (openFence spin) e faz clean-room dos OUTROS faltantes. O travado já tem
      // corpo recuperável (recoverOpen) → NÃO está em `missing` → o registramos como abandonado (Task.run o
      // marca PARCIAL). Um travado SEM corpo continua em `missing` e é re-emitido do zero pela clean-room —
      // esse NÃO é abandonado. Injeta \n para a cerca do próximo arquivo cair no início de linha (senão é
      // engolida). Reseta o streak para não vazar para o próximo arquivo travado.
      const stuck = completeness.path;
      if (stuck) {
        const stuckNorm = normResilientPath(stuck);
        const bodied = !missing.some((m) => normResilientPath(m) === stuckNorm);
        if (bodied && !abandonedPaths.some((a) => normResilientPath(a) === stuckNorm)) abandonedPaths.push(stuck);
      }
      if (!full.endsWith("\n")) full += "\n";
      stuckPath = undefined;
      stuckStreak = 0;
      convo = [...baseMessages, { role: "user", content: opts.buildMissingFilesContinuation!(missing, emittedContracts(full, completeness.path)) }];
    } else if (!openFence && missing.length > 0 && opts.buildMissingFilesContinuation) {
      // Clean-room (F-02): faltam arquivos do plano e o último bloco NÃO ficou aberto. Pede os faltantes
      // NOMEADOS como blocos novos e autônomos, SEM a âncora da cauda — ela só convida a re-emissão da cauda
      // (stitch dedupa → crescimento zero → stall). O plano+propósitos vivem no system prompt (constante).
      // R5: os contratos reais dos já-emitidos vão na mensagem para o modelo não regenerar os faltantes cego.
      convo = [...baseMessages, { role: "user", content: opts.buildMissingFilesContinuation(missing, emittedContracts(full, completeness.path)) }];
    } else {
      // cerca aberta → continuar o MESMO arquivo (âncora obrigatória p/ retomar no ponto exato do corte);
      // corte sem faltantes conhecidos (ex.: chat, missing=[]) → tail genérico, também ancorado.
      const anchor = full.length > opts.anchorChars ? full.slice(-opts.anchorChars) : full;
      const instruction = openFence ? opts.buildContinuation(completeness.path) : opts.buildTailContinuation(missing.length ? missing : undefined);
      convo = [...baseMessages, { role: "assistant", content: anchor }, { role: "user", content: instruction }];
    }
  }
}
