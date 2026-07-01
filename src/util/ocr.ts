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

// Locais PADRÃO de instalação do tesseract no Windows, em ordem de preferência — inclui o caminho
// POR-USUÁRIO (`%LOCALAPPDATA%\Programs\...`), que é onde uma instalação sem admin / portable costuma
// ficar. Em outros SOs os env vars não existem → lista vazia → cai no `tesseract` do PATH (brew/apt).
export function tesseractCandidates(env: Record<string, string | undefined>): string[] {
  const join = (base: string | undefined, ...parts: string[]) => (base ? [base.replace(/[\\/]+$/, ""), ...parts].join("\\") : null);
  return [
    join(env.ProgramFiles, "Tesseract-OCR", "tesseract.exe"),
    join(env["ProgramFiles(x86)"], "Tesseract-OCR", "tesseract.exe"),
    join(env.LOCALAPPDATA, "Programs", "Tesseract-OCR", "tesseract.exe"), // instalação por-usuário (sem admin)
    join(env.LOCALAPPDATA, "Tesseract-OCR", "tesseract.exe"),
    join(env.USERPROFILE, "scoop", "apps", "tesseract", "current", "tesseract.exe"), // scoop (per-user)
  ].filter((p): p is string => !!p);
}

// Resolve QUAL comando/caminho de tesseract usar: (1) o configurado explicitamente (respeitado como-está,
// mesmo que aponte para portable), senão (2) o 1º candidato que EXISTE em disco, senão (3) "tesseract"
// no PATH (o spawn dá ENOENT se faltar → o chamador mostra a dica). Puro/testável (fileExists injetado).
export function resolveTesseractCmd(configuredPath: string, candidates: string[], fileExists: (p: string) => boolean): string {
  const cfg = (configuredPath ?? "").trim();
  if (cfg) return cfg;
  for (const c of candidates) if (fileExists(c)) return c;
  return "tesseract";
}
