// Mapa de linguagem (o info-string de uma cerca markdown, ex.: ```python) → extensão de arquivo. Usado
// pelo botão "Salvar como arquivo" do CodeBox (webview): (a) decide se o trecho é "conteúdo de arquivo"
// salvável e (b) sugere um nome default. Puro e COMPARTILHADO (host + webview), então é testável no
// runner do host. Ver webview-ui/src/components/Markdown.tsx (CodeBox) e Controller.saveCodeBlock.
const LANG_EXT: Record<string, string> = {
  python: "py", py: "py",
  typescript: "ts", ts: "ts", tsx: "tsx",
  javascript: "js", js: "js", jsx: "jsx", mjs: "mjs",
  java: "java", kotlin: "kt", kt: "kt", scala: "scala",
  go: "go", golang: "go", rust: "rs", rs: "rs", ruby: "rb", rb: "rb",
  c: "c", cpp: "cpp", "c++": "cpp", csharp: "cs", cs: "cs", php: "php",
  sql: "sql", r: "r",
  json: "json", yaml: "yaml", yml: "yaml", toml: "toml", xml: "xml",
  html: "html", css: "css", scss: "scss",
  markdown: "md", md: "md",
  dockerfile: "dockerfile",
};

// Extensão de arquivo para a linguagem de uma cerca, ou null quando a cerca NÃO é conteúdo de arquivo
// salvável — shell/console/saída/diff/texto puro/sem linguagem. Nesses casos o botão "Salvar como
// arquivo" não aparece: não faz sentido gravar um comando de shell ou a saída de um comando como arquivo.
export function fileExtForLang(lang: string): string | null {
  const key = (lang ?? "").trim().toLowerCase();
  return LANG_EXT[key] ?? null;
}
