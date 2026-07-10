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
  | "help.footer"
  | "cmd.translateSql.prompt"
  | "cmd.parity.usage"
  | "cmd.gitCommit.prompt"
  | "cmd.unknown";

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
    "cmd.translateSql.prompt": "Informe o dialeto alvo: `/traduzir-sql <dialeto>` — um de: {dialects}.",
    "cmd.parity.usage": "Uso: `/paridade tabela_a tabela_b` — opcionalmente `conexao:tabela` em cada lado (paridade entre warehouses).",
    "cmd.gitCommit.prompt": "Informe a mensagem: `/git-commit \"sua mensagem de commit\"`. Commita os arquivos rastreados modificados (com confirmação).",
    "cmd.unknown": "Comando desconhecido: `{text}` — digite `/` para ver a paleta ou `/ajuda`.",
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
    "cmd.translateSql.prompt": "Enter the target dialect: `/translate-sql <dialect>` — one of: {dialects}.",
    "cmd.parity.usage": "Usage: `/parity table_a table_b` — optionally `connection:table` on each side (cross-warehouse parity).",
    "cmd.gitCommit.prompt": "Enter the message: `/git-commit \"your commit message\"`. Commits the modified tracked files (with confirmation).",
    "cmd.unknown": "Unknown command: `{text}` — type `/` to see the palette or `/help`.",
  },
};
