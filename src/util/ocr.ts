// OCR de um print colado no chat (ponto 6): o texto extraído vira um anexo, para o modelo "ler" o
// print (ex.: logs/erros). O motor é o `tesseract` do SISTEMA (CLI) — leve, sem inchar o .vsix. Estes
// helpers são PUROS (parse do data URL colado e escolha dos idiomas), isolados para teste. A invocação
// do binário e a I/O ficam no Controller.

export interface ParsedImage {
  mime: string; // ex.: "image/png"
  ext: string; // extensão do arquivo temporário (jpeg → jpg)
  base64: string; // conteúdo em base64, sem o prefixo data:
}

// Extrai {mime, ext, base64} de um data URL de imagem (o que o clipboard entrega ao colar um print).
// Tolerante a espaços/quebras no base64. Retorna null se não for uma imagem base64 válida.
export function parseImageDataUrl(dataUrl: string): ParsedImage | null {
  const m = /^data:(image\/([a-z0-9.+-]+));base64,([a-z0-9+/=\s]+)$/i.exec((dataUrl ?? "").trim());
  if (!m) return null;
  const mime = m[1].toLowerCase();
  const sub = m[2].toLowerCase();
  const ext = sub === "jpeg" ? "jpg" : sub;
  const base64 = m[3].replace(/\s+/g, "");
  if (!base64) return null;
  return { mime, ext, base64 };
}

// Escolhe, entre os idiomas DISPONÍVEIS no tesseract instalado, os desejados (padrão: por+eng), na ordem
// pedida. Vazio = nenhum dos desejados está instalado → o chamador roda o tesseract sem `-l` (default eng).
export function pickOcrLangs(available: string[], wanted: string[] = ["por", "eng"]): string[] {
  const set = new Set((available ?? []).map((s) => s.trim()).filter(Boolean));
  return wanted.filter((l) => set.has(l));
}

// Faz o parse da saída de `tesseract --list-langs` (a 1ª linha é um cabeçalho "List of available…").
export function parseTesseractLangs(output: string): string[] {
  return (output ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^List of/i.test(s));
}
