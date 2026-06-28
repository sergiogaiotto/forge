import { FORGE_FILE_BLOCK_LANG } from "../shared/protocol";
import { scanFencedBlocks } from "./fences";

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

// Scanner único: delega ao scanner genérico de cercas (suporta cerca de N>=3 crases, ver fences.ts e
// o protocolo em systemPrompt.ts) e extrai o `path=` do cabeçalho. Host e webview compartilham este
// scanner, então SEMPRE concordam sobre o que é um bloco (o que vira proposta == o que vira cartão ==
// o que é removido da prosa).
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

// Extrai os blocos forge-file COMPLETOS (fechados, com path) que o modelo emite — veja o protocolo de
// edição de arquivos em systemPrompt.ts. Usado no host ao final do stream para gerar as propostas de
// diff. PARSER AUTORITATIVO: o que ele aceita é o que vira proposta aplicável.
export function parseFileBlocks(text: string): FileBlock[] {
  return scanFileBlocks(text)
    .filter((b) => b.closed && b.path.length > 0)
    .map(({ path, content }) => ({ path, content }));
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
// como prosa, para que a cerca crua nunca apareça no chat. Blocos inválidos (fechado sem path,
// prefixo falso) NÃO são removidos — permanecem como texto, em sintonia com o host que os ignora,
// evitando perda silenciosa de conteúdo.
export function stripFileBlocksFromText(text: string): string {
  return removeBlocks(text, scanFileBlocks(text).filter(isValidBlock));
}

// Remove do texto APENAS o bloco forge-file de um caminho específico. A webview usa isto quando a
// proposta concreta chega (uma de cada vez), para não duplicar a cerca crua. Usa o mesmo scanner —
// então respeita cercas de N crases e não trunca em fences internos do conteúdo.
export function stripFileBlockOfPath(text: string, filePath: string): string {
  return removeBlocks(text, scanFileBlocks(text).filter((b) => b.closed && b.path === filePath));
}

function removeBlocks(text: string, blocks: ScannedBlock[]): string {
  if (blocks.length === 0) return text;
  let out = "";
  let cur = 0;
  for (const b of blocks) {
    out += text.slice(cur, b.start);
    cur = b.end;
  }
  out += text.slice(cur);
  return out.replace(/\n{3,}/g, "\n\n").trimEnd();
}

function extractPath(header: string): string {
  const m = header.match(/path=([^\n`]+)/);
  if (!m) return "";
  return m[1].trim().replace(/^["']|["']$/g, "");
}
