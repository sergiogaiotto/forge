// Camada i18n do HOST: hostT(key, params) com fallback pt-BR. O locale é fixado UMA vez na ativação da
// extensão a partir de vscode.env.language (o idioma do VSCode não muda em runtime). PURO — NÃO importa
// vscode: o locale é injetado por setHostLocale (chamado no extension.ts com resolveLocale(env.language)).
// Assim toda a lógica de tradução fica testável em Node puro, e o host serve INGLÊS a um usuário en
// (o vscode.l10n nativo não conseguiria — ver hostMessages.ts).
import { DEFAULT_LOCALE, Locale } from "../shared/locale";
import { formatMessage } from "../shared/format";
import { HOST_MESSAGES, HostMessageKey } from "./hostMessages";

let activeLocale: Locale = DEFAULT_LOCALE;

// Chamado na ativação: setHostLocale(resolveLocale(vscode.env.language)).
export function setHostLocale(locale: Locale): void {
  activeLocale = locale;
}

export function getHostLocale(): Locale {
  return activeLocale;
}

// Resolve a chave no locale ativo; ausente → fallback pt-BR; ainda ausente → a própria chave (buraco
// visível, nunca vazio). Interpola/pluraliza os params.
export function hostT(key: HostMessageKey, params?: Record<string, string | number>): string {
  const template = HOST_MESSAGES[activeLocale]?.[key] ?? HOST_MESSAGES[DEFAULT_LOCALE]?.[key] ?? key;
  return formatMessage(template, params);
}

export type { HostMessageKey };
