import type { Locale } from "../shared/locale";

// Catálogo de mensagens do HOST por locale. Espelha a camada da webview (pt-BR é a FONTE completa; en é
// override — chave ausente cai para pt-BR). Existe uma camada PRÓPRIA (em vez de vscode.l10n) porque o
// produto é pt-BR-FIRST: o vscode.l10n é arquiteturalmente incapaz de servir INGLÊS a partir de uma
// fonte pt-BR (o inglês é a língua-DEFAULT do VSCode, que curto-circuita o carregamento do bundle — um
// usuário en receberia a string-fonte pt-BR). Uma camada própria, lida de vscode.env.language, escolhe o
// catálogo sem esse curto-circuito. Chaves estáveis (namespace.pontos), sem acento; o TEXTO é o que traduz.
export type HostMessageKey =
  | "dialog.skillsReindexed"
  | "dialog.signedOut"
  | "notice.openFolder.rules"
  | "notice.rule.exists"
  | "notice.charterSaved"
  | "notice.noBlueprint";

export const HOST_MESSAGES: Record<Locale, Partial<Record<HostMessageKey, string>>> = {
  "pt-BR": {
    "dialog.skillsReindexed": "FORGE: skills reindexadas.",
    "dialog.signedOut": "FORGE: licença e credenciais removidas.",
    "notice.openFolder.rules": "Abra uma pasta no VS Code para salvar regras do projeto.",
    "notice.rule.exists": "Essa regra já está no perfil do projeto.",
    "notice.charterSaved": "Charter salvo em .forge/project.md (injetado em todo prompt).",
    "notice.noBlueprint": "Nenhum blueprint aprovado. Planeje o projeto primeiro.",
  },
  en: {
    "dialog.skillsReindexed": "FORGE: skills reindexed.",
    "dialog.signedOut": "FORGE: license and credentials removed.",
    "notice.openFolder.rules": "Open a folder in VS Code to save project rules.",
    "notice.rule.exists": "This rule is already in the project profile.",
    "notice.charterSaved": "Charter saved to .forge/project.md (injected into every prompt).",
    "notice.noBlueprint": "No approved blueprint. Plan the project first.",
  },
};
