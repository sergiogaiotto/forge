import { FORGE_CELL_BLOCK_LANG, FORGE_FILE_BLOCK_LANG } from "../shared/protocol";
import { findClosingFence, findOpeningFence, scanFencedBlocks } from "./fences";

export interface FileBlock {
  path: string;
  content: string;
}

export interface PartialFileBlock {
  path: string;
  content: string;
  closed: boolean; // false enquanto a cerca de fechamento ainda não chegou (streaming)
}

interface ScannedBlock extends PartialFileBlock {
  start: number; // índice do início da cerca de abertura
  end: number; // índice logo após o bloco (após a cerca de fechamento, ou fim do texto se aberto)
}

// Span final (com offsets) de um bloco que vira proposta. `end` delimita o que será removido da prosa
// (stripFileBlockOfPath), então parse e strip ficam sempre coerentes (mesmo span).
interface FinalBlock extends FileBlock {
  start: number;
  end: number;
}

// Uma linha "só cerca": apenas crases (>=3) seguidas de espaços/tabs/CR. Tolera \r (CRLF).
const BARE_FENCE_RE = /^(`{3,})[ \t\r]*$/;

// Scanner de blocos forge-file para os caminhos de STREAMING (preview ao vivo e remoção da cerca crua
// enquanto o modelo gera). Delega ao scanner genérico de cercas (ver fences.ts) e extrai o `path=`.
function scanFileBlocks(text: string): ScannedBlock[] {
  return scanFencedBlocks(text, FORGE_FILE_BLOCK_LANG).map((f) => ({
    path: extractPath(f.info),
    content: f.content,
    closed: f.closed,
    start: f.start,
    end: f.end,
  }));
}

// Contrato compartilhado com o host: um bloco FECHADO só é válido com path não-vazio (o host não
// gera proposta sem caminho). Um bloco ainda em streaming é tolerado — o path pode estar chegando.
function isValidBlock(b: ScannedBlock): boolean {
  return b.closed ? b.path.length > 0 : true;
}

// Início da próxima abertura (forge-file OU forge-cell) com PELO MENOS `minFenceLen` crases, a partir
// de `from`; -1 se não houver. Serve de fronteira do bloco atual: um bloco NUNCA pode se estender por
// cima da abertura de outro de fence >= ao seu — senão engole o bloco seguinte (proposta-amálgama,
// achado crítico). O filtro `>= minFenceLen` é essencial: uma cerca interna mais CURTA que a abertura
// (ex.: um ```forge-file de 3 crases DENTRO de um bloco de 4 que documenta o protocolo) é CONTEÚDO
// protegido pela garantia das 4 crases, não uma fronteira — tratá-la como fronteira truncaria o bloco.
function nextOpeningStart(text: string, from: number, minFenceLen: number): number {
  let best = -1;
  for (const lang of [FORGE_FILE_BLOCK_LANG, FORGE_CELL_BLOCK_LANG]) {
    let i = from;
    for (;;) {
      const o = findOpeningFence(text, lang, i);
      if (!o) break;
      if (o.fenceLen >= minFenceLen) {
        if (best === -1 || o.start < best) best = o.start;
        break;
      }
      i = o.afterLang; // ignora abertura mais curta (conteúdo protegido); procura a próxima
    }
  }
  return best;
}

// Há alguma linha que não seja vazia nem só uma cerca? (corpo de arquivo de fato)
function hasRealBody(content: string): boolean {
  return content.split("\n").some((l) => l.trim() !== "" && !BARE_FENCE_RE.test(l));
}

// Recupera um bloco forge-file que o modelo ABRIU mas não fechou com a contagem de crases certa
// (esqueceu o fechamento, ou abriu 3 / fechou 4). `content` já vem LIMITADO à fronteira do bloco
// (próximo bloco ou fim do texto), então a recuperação nunca engole o bloco seguinte. CONSERVADORA:
//  - exige path e um corpo de arquivo REAL (linha não-vazia que não seja só cerca) — assim um bloco
//    cujo único "conteúdo" é a cerca residual NÃO vira proposta de arquivo vazio (sobrescreveria um
//    arquivo existente);
//  - se houver uma cerca "solta" de fechamento (linha só de crases com >= a contagem de ABERTURA),
//    corta ali: delimita o arquivo e devolve o resto à prosa. Cercas internas mais CURTAS ficam no
//    conteúdo (mesma garantia das 4 crases). Sem cerca solta, recupera todo o `content` limitado.
function recoverOpen(
  path: string,
  content: string,
  fenceLen: number,
  start: number,
  contentStart: number
): FinalBlock | null {
  if (path.length === 0) return null;

  let body = content;
  let end = contentStart + content.length; // fronteira (próximo bloco ou EOF)
  let pos = 0;
  for (;;) {
    const nl = content.indexOf("\n", pos);
    const lineEnd = nl === -1 ? content.length : nl;
    const m = content.slice(pos, lineEnd).match(BARE_FENCE_RE);
    if (m && m[1].length >= fenceLen) {
      body = content.slice(0, pos);
      end = contentStart + (nl === -1 ? lineEnd : nl + 1); // consome a linha da cerca (e seu \n)
      break;
    }
    if (nl === -1) break;
    pos = nl + 1;
  }

  body = body.replace(/\r?\n$/, ""); // tira a quebra final (antes da cerca solta ou da fronteira)
  if (!hasRealBody(body)) return null;
  return { path, content: body, start, end };
}

// Lista FINAL e autoritativa dos blocos forge-file que viram proposta — usada pelo host
// (parseFileBlocks) e, para manter strip e parse coerentes, por stripFileBlockOfPath. Varre as
// aberturas linearmente e fecha cada bloco no que vier PRIMEIRO: a cerca de fechamento exata OU a
// abertura do próximo bloco (file/cell). Um bloco sem fechamento exato antes do próximo passa pela
// recuperação tolerante (recoverOpen). Só roda no texto COMPLETO (pós-stream), então recuperar um
// bloco aberto é seguro aqui — nunca no meio do stream.
function finalFileBlocks(text: string): FinalBlock[] {
  const out: FinalBlock[] = [];
  let i = 0;
  for (;;) {
    const open = findOpeningFence(text, FORGE_FILE_BLOCK_LANG, i);
    if (!open) break;
    const headerNl = text.indexOf("\n", open.afterLang);
    if (headerNl === -1) break; // cabeçalho incompleto no fim do texto: sem corpo
    const contentStart = headerNl + 1;
    const path = extractPath(text.slice(open.afterLang, headerNl));
    const close = findClosingFence(text, contentStart, open.fenceLen);
    const next = nextOpeningStart(text, contentStart, open.fenceLen);

    // Fecha aqui se há fechamento exato E ele vem ANTES da abertura do próximo bloco.
    if (close && (next === -1 || close.lineStart <= next)) {
      const content = text.slice(contentStart, close.lineStart).replace(/\r?\n$/, "");
      if (path) out.push({ path, content, start: open.start, end: close.end });
      i = close.end;
      continue;
    }
    // Sem fechamento exato antes do próximo bloco: abriu e não fechou direito. Recupera LIMITADO à
    // fronteira — o `content` não inclui a abertura do próximo bloco.
    const boundary = next === -1 ? text.length : next;
    const rec = recoverOpen(path, text.slice(contentStart, boundary), open.fenceLen, open.start, contentStart);
    if (rec) out.push(rec);
    if (next === -1) break;
    i = next;
  }
  return out;
}

// Extrai os blocos forge-file que o modelo emite — veja o protocolo de edição de arquivos em
// systemPrompt.ts. Usado no host ao final do stream para gerar as propostas de diff. PARSER
// AUTORITATIVO: o que ele aceita é o que vira proposta aplicável.
export function parseFileBlocks(text: string): FileBlock[] {
  return finalFileBlocks(text).map(({ path, content }) => ({ path, content }));
}

// Extrai blocos forge-file inclusive os AINDA EM STREAMING (cerca de fechamento não emitida).
// A webview usa isto para renderizar um cartão "ao vivo" enquanto o modelo gera, em vez de exibir
// a cerca crua no chat. Blocos fechados sem path são ignorados (o host não os aplicaria).
export function parsePartialFileBlocks(text: string): PartialFileBlock[] {
  return scanFileBlocks(text)
    .filter(isValidBlock)
    .map(({ path, content, closed }) => ({ path, content, closed }));
}

// Remove os blocos forge-file (os mesmos que parsePartialFileBlocks reconhece) do texto exibido
// como prosa DURANTE o streaming, para que a cerca crua nunca apareça no chat. Blocos inválidos
// (fechado sem path, prefixo falso) NÃO são removidos — permanecem como texto, em sintonia com o host
// que os ignora, evitando perda silenciosa de conteúdo.
export function stripFileBlocksFromText(text: string): string {
  return removeBlocks(text, scanFileBlocks(text).filter(isValidBlock));
}

// Remove do texto APENAS o bloco forge-file de um caminho específico. A webview usa isto quando a
// proposta concreta chega (uma de cada vez), para não duplicar a cerca crua. Usa a MESMA lista final
// que parseFileBlocks (finalFileBlocks) — mesmo span — então o que virou proposta é exatamente o que
// sai da prosa (sem cartão-zumbi nem cerca crua sobrando).
export function stripFileBlockOfPath(text: string, filePath: string): string {
  return removeBlocks(text, finalFileBlocks(text).filter((b) => b.path === filePath));
}

function removeBlocks(text: string, blocks: { start: number; end: number }[]): string {
  if (blocks.length === 0) return text;
  let out = "";
  let cur = 0;
  for (const b of blocks) {
    out += text.slice(cur, b.start);
    cur = b.end;
  }
  out += text.slice(cur);
  // Colapsa 3+ quebras em 2 (LF ou CRLF), preservando o estilo de quebra do trecho.
  return out.replace(/(\r?\n){3,}/g, (m) => (m.indexOf("\r") >= 0 ? "\r\n\r\n" : "\n\n")).trimEnd();
}

// Extrai o caminho do info-string do cabeçalho. Aceita aspas (permitem espaços) e, sem aspas, para na
// primeira fronteira de espaço/crase — assim `path=a.py mode=x` vira `a.py`, não `a.py mode=x`.
function extractPath(header: string): string {
  const m = header.match(/path=(?:"([^"\n]*)"|'([^'\n]*)'|([^\s`]+))/);
  if (!m) return "";
  return (m[1] ?? m[2] ?? m[3] ?? "").trim();
}
