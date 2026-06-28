import { FORGE_FILE_BLOCK_LANG } from "../core/systemPrompt";

export interface FileBlock {
  path: string;
  content: string;
}

// Extrai os blocos ```forge-file path=...``` que o modelo emite (veja o protocolo
// de edição de arquivos em systemPrompt.ts). Mantido sem dependências para testes unitários.
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
