// Locale COMPARTILHADO host↔webview (i18n, Fase 4). Uma única fonte de verdade para a normalização do
// idioma: o host lê `vscode.env.language` (pode vir "pt-br", "en-US", "es", …) e reduz aos locales que o
// FORGE suporta. O produto é pt-BR-first, então pt-BR é o DEFAULT/fallback (o EN é override — invertido
// em relação à convenção usual). PURO/testável. Importado pelo host (WebviewProvider) e pela webview.
export type Locale = "pt-BR" | "en";
export const DEFAULT_LOCALE: Locale = "pt-BR";
export const SUPPORTED_LOCALES: Locale[] = ["pt-BR", "en"];

// Reduz um código de idioma arbitrário do VSCode ao locale suportado. Casa por PREFIXO (en-US → en,
// pt-br → pt-BR); desconhecido → default pt-BR (nunca cai num idioma vazio).
export function resolveLocale(raw: string | undefined | null): Locale {
  const s = (raw ?? "").trim().toLowerCase();
  if (s.startsWith("en")) return "en";
  if (s.startsWith("pt")) return "pt-BR";
  return DEFAULT_LOCALE;
}
