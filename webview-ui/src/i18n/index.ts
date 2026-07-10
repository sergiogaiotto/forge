// Camada i18n da webview: t(key, params) com fallback pt-BR. O locale é fixado UMA vez no boot a partir
// do `data-locale` do #root (injetado pelo host — WebviewProvider.getHtml), pois o idioma do VSCode não
// muda em runtime. Sem React context/re-render: o valor é lido antes do primeiro render (main.tsx).
import { DEFAULT_LOCALE, Locale, resolveLocale } from "../../../src/shared/locale";
import { formatMessage } from "../../../src/shared/format";
import { MESSAGES, MessageKey } from "./messages";

let activeLocale: Locale = DEFAULT_LOCALE;

// Lê o locale do data-locale do #root (ou de um valor explícito, útil para teste). Chamado no boot.
export function initLocale(explicit?: string): Locale {
  const fromDom = typeof document !== "undefined" ? document.getElementById("root")?.dataset.locale : undefined;
  activeLocale = resolveLocale(explicit ?? fromDom ?? DEFAULT_LOCALE);
  return activeLocale;
}

export function getLocale(): Locale {
  return activeLocale;
}

// Resolve uma chave no locale ativo; ausente → fallback pt-BR; ainda ausente → a própria chave (torna o
// buraco visível em vez de renderizar vazio). Interpola/pluraliza os params.
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const template = MESSAGES[activeLocale]?.[key] ?? MESSAGES[DEFAULT_LOCALE]?.[key] ?? key;
  return formatMessage(template, params);
}

// Exposto para teste determinístico (força o locale sem tocar o DOM).
export function setLocaleForTest(locale: Locale): void {
  activeLocale = locale;
}

export type { MessageKey };
