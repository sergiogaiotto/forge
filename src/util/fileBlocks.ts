import { FORGE_FILE_BLOCK_LANG } from "../shared/protocol";

export interface FileBlock {
  path: string;
  content: string;
}

// Extrai os blocos ```forge-file path=...``` (apenas os COMPLETOS) que o modelo emite — veja o
// protocolo de edição de arquivos em systemPrompt.ts. Usado no host ao final do stream para gerar
// as propostas de diff. PARSER AUTORITATIVO: o que ele aceita é o que vira proposta aplicável.
export function parseFileBlocks(text: string): FileBlock[] {
  const re = new RegExp("```" + FORGE_FILE_BLOCK_LANG + "\\s+path=([^\\n`]+)\\n([\\s\\S]*?)```", "g");
  const out: FileBlock[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const p = m[1].trim().replace(/^["']|["']$/g, "");
    let content = m[2];
    if (content.endsWith("\n")) content = content.slice(0, -1);
    out.push({ path: p, content });
  }
  return out;
}

export interface PartialFileBlock {
  path: string;
  content: string;
  closed: boolean; // false enquanto a cerca de fechamento ``` ainda não chegou (streaming)
}

interface ScannedBlock extends PartialFileBlock {
  start: number; // índice do início da cerca de abertura
  end: number; // índice logo após o bloco (após o ``` de fechamento, ou fim do texto se aberto)
}

const FENCE_TOKEN = "```" + FORGE_FILE_BLOCK_LANG;

// Encontra a próxima cerca de abertura EXIGINDO fronteira após o token da linguagem (espaço/tab/
// quebra/fim), espelhando o `\s+` do parser autoritativo. Assim ```forge-fileXYZ NÃO casa — evita
// que a webview "veja" um bloco que o host nunca transformaria em proposta.
function findFenceStart(text: string, from: number): number {
  let i = from;
  for (;;) {
    const start = text.indexOf(FENCE_TOKEN, i);
    if (start === -1) return -1;
    const after = text[start + FENCE_TOKEN.length];
    if (after === undefined || after === " " || after === "\t" || after === "\r" || after === "\n") return start;
    i = start + FENCE_TOKEN.length; // pula falso prefixo (forge-fileXYZ)
  }
}

// Scanner único usado por parsePartialFileBlocks e stripFileBlocksFromText, para que a webview
// SEMPRE concorde sobre o que é um bloco (o que vira cartão == o que é removido da prosa). A regra
// de fechamento (primeiro ```) é deliberadamente igual à do parseFileBlocks do host.
function scanFileBlocks(text: string): ScannedBlock[] {
  const out: ScannedBlock[] = [];
  let i = 0;
  for (;;) {
    const start = findFenceStart(text, i);
    if (start === -1) break;
    const afterFence = start + FENCE_TOKEN.length;
    const nl = text.indexOf("\n", afterFence);
    if (nl === -1) {
      // Cabeçalho ainda chegando (o caminho pode estar incompleto).
      out.push({ path: extractPath(text.slice(afterFence)), content: "", closed: false, start, end: text.length });
      break;
    }
    const path = extractPath(text.slice(afterFence, nl));
    const close = text.indexOf("```", nl + 1);
    if (close === -1) {
      out.push({ path, content: text.slice(nl + 1), closed: false, start, end: text.length });
      break;
    }
    let content = text.slice(nl + 1, close);
    if (content.endsWith("\n")) content = content.slice(0, -1);
    out.push({ path, content, closed: true, start, end: close + 3 });
    i = close + 3;
  }
  return out;
}

// Contrato compartilhado com o host: um bloco FECHADO só é válido com path não-vazio (o host não
// gera proposta sem caminho). Um bloco ainda em streaming é tolerado — o path pode estar chegando.
function isValidBlock(b: ScannedBlock): boolean {
  return b.closed ? b.path.length > 0 : true;
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
  const blocks = scanFileBlocks(text).filter(isValidBlock);
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
