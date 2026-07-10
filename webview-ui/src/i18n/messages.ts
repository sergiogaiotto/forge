import type { Locale } from "../../../src/shared/locale";

// Catálogo de mensagens da webview por locale. pt-BR é a FONTE (completa); en é override — uma chave
// ausente no en cai para pt-BR (ver t()). Chaves são estáveis e sem acento (namespace.pontos); o TEXTO
// é o que traduz. Este é o piloto (App.tsx) — as demais superfícies entram nos PRs seguintes.
export type MessageKey =
  | "app.loading"
  | "mcp.approve.title"
  | "mcp.approve.before"
  | "mcp.approve.on"
  | "mcp.approve.scope"
  | "common.deny"
  | "common.allow"
  | "help.title"
  | "help.colCommand"
  | "help.colWhat"
  | "help.footer";

export const MESSAGES: Record<Locale, Partial<Record<MessageKey, string>>> = {
  "pt-BR": {
    "app.loading": "Carregando FORGE…",
    "mcp.approve.title": "Aprovar ferramenta MCP",
    "mcp.approve.before": "O agente quer chamar",
    "mcp.approve.on": "em",
    "mcp.approve.scope": "(escopo {scope}).",
    "common.deny": "Negar",
    "common.allow": "Permitir",
    "help.title": "Paleta de comandos",
    "help.colCommand": "comando",
    "help.colWhat": "o que faz",
    "help.footer": "Digite `/` no chat para autocompletar.",
  },
  en: {
    "app.loading": "Loading FORGE…",
    "mcp.approve.title": "Approve MCP tool",
    "mcp.approve.before": "The agent wants to call",
    "mcp.approve.on": "on",
    "mcp.approve.scope": "(scope {scope}).",
    "common.deny": "Deny",
    "common.allow": "Allow",
    "help.title": "Command palette",
    "help.colCommand": "command",
    "help.colWhat": "what it does",
    "help.footer": "Type `/` in the chat to autocomplete.",
  },
};
