import type { Locale } from "../../../src/shared/locale";

// Catálogo de mensagens da webview por locale. pt-BR é a FONTE (completa); en é override — uma chave
// ausente no en cai para pt-BR (ver t()). Chaves são estáveis e sem acento (namespace.pontos); o TEXTO
// é o que traduz. Superfícies cobertas: App.tsx (piloto), cards da paleta (ctx/tok/sum), Onboarding (ob),
// caixa de código do Markdown (md) e o reducer (charter). DevPanel entra no PR seguinte.
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
  | "cmd.unknown"
  // /contexto (renderContextReport)
  | "ctx.title"
  | "ctx.colTokens"
  | "ctx.window"
  | "ctx.outputReserve"
  | "ctx.inputBudget"
  | "ctx.pinned"
  | "ctx.history"
  | "ctx.attachments"
  | "ctx.estimate"
  | "ctx.rag"
  | "ctx.session"
  | "ctx.footnote"
  // /tokens (renderTokensReport)
  | "tok.title"
  | "tok.empty"
  | "tok.colIn"
  | "tok.colOut"
  | "tok.last"
  | "tok.session"
  | "tok.footnote"
  // /resumir (renderSummarized)
  | "sum.title"
  | "sum.body"
  // Onboarding
  | "ob.subtitle"
  | "ob.internalNetwork"
  | "ob.step.license"
  | "ob.step.provider"
  | "ob.license.title"
  | "ob.license.sub"
  | "ob.license.valid"
  | "ob.license.verify"
  | "ob.email.label"
  | "ob.email.placeholder"
  | "ob.email.note"
  | "ob.email.confirm"
  | "ob.email.identified"
  | "ob.email.manual"
  | "ob.provider.title"
  | "ob.provider.sub"
  | "ob.provider.test"
  | "ob.provider.finishTitleEmail"
  | "ob.provider.finishTitle"
  | "ob.provider.finish"
  | "ob.field.baseUrl"
  | "ob.field.model"
  | "ob.field.timeout"
  | "ob.field.apiKey"
  | "ob.field.endpoint"
  | "ob.field.dims"
  | "ob.test.connOk"
  | "ob.test.fail"
  | "ob.rag.title"
  | "ob.rag.sub.before"
  | "ob.rag.sub.after"
  | "ob.rag.dimsDefault"
  | "ob.rag.none"
  | "ob.rag.ok"
  | "ob.rag.test"
  | "ob.foot.admin"
  | "ob.foot.network"
  | "ob.foot.secrets"
  | "ob.status.configure"
  | "ob.status.provider"
  // Caixa de código do Markdown (CodeBox)
  | "md.code.lang"
  | "md.code.generating"
  | "md.code.proposalCreated"
  | "md.code.saveTitle"
  | "md.code.saveAsFile"
  | "md.code.copy"
  | "md.code.copied"
  | "md.code.newFile"
  | "md.code.pathPlaceholder"
  | "md.code.confirmTitle"
  | "md.code.save"
  | "md.code.cancel"
  // Reducer (state.ts)
  | "charter.emptyDraft";

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
    "ctx.title": "Janela de contexto",
    "ctx.colTokens": "tokens",
    "ctx.window": "Janela total",
    "ctx.outputReserve": "Reserva de saída",
    "ctx.inputBudget": "Orçamento de entrada",
    "ctx.pinned": "Fixo (prompt do chat + perfil)",
    "ctx.history": "Histórico ({count, plural, one{# turno} other{# turnos}})",
    "ctx.attachments": "Anexos pendentes ({count})",
    "ctx.estimate": "Ocupação estimada do próximo envio:",
    "ctx.rag": "RAG: {count, plural, one{# chunk indexado} other{# chunks indexados}} (entram por consulta, conforme o orçamento)",
    "ctx.session": "Sessão: {input} tokens de entrada · {output} de saída",
    "ctx.footnote": "Estimativas heurísticas (o tokenizer real varia; TDD/Projeto têm prompt fixo um pouco maior). {clearCmd} zera o histórico.",
    "tok.title": "Uso de tokens",
    "tok.empty": "Ainda não houve geração nesta sessão — os números aparecem após a primeira resposta do modelo.",
    "tok.colIn": "entrada",
    "tok.colOut": "saída",
    "tok.last": "Última geração",
    "tok.session": "Sessão (acumulado)",
    "tok.footnote": "Continuações automáticas somam no acumulado da geração (cada passe reenvia contexto).",
    "sum.title": "Histórico compactado",
    "sum.body":
      "{turns, plural, one{# turno virou} other{# turnos viraram}} o resumo abaixo — é ISTO que o modelo passa a receber como contexto da conversa (a thread acima é só exibição; {clearCmd} zera tudo).",
    "ob.subtitle": "configuração inicial",
    "ob.internalNetwork": "rede interna",
    "ob.step.license": "Licença",
    "ob.step.provider": "Provedor",
    "ob.license.title": "Ativar licença",
    "ob.license.sub": "Cole a chave fornecida pelo admin. A assinatura é verificada localmente (Ed25519) e confirmada no servidor.",
    "ob.license.valid": "Assinatura válida · org {org} · expira em {expiry}",
    "ob.license.verify": "Verificar e ativar",
    "ob.email.label": "Seu e-mail corporativo (obrigatório)",
    "ob.email.placeholder": "voce@claro.com.br",
    "ob.email.note": "A licença não identifica você automaticamente. O e-mail é usado como sua identidade na observabilidade (Langfuse).",
    "ob.email.confirm": "Confirmar e-mail",
    "ob.email.identified": "Identificado como {email}",
    "ob.email.manual": "(informado)",
    "ob.provider.title": "Escolher provedor",
    "ob.provider.sub": "Selecione o backend de modelo. O HubGPU usa o endpoint OpenAI-compatible.",
    "ob.provider.test": "Testar conexão",
    "ob.provider.finishTitleEmail": "Informe seu e-mail antes de concluir",
    "ob.provider.finishTitle": "Concluir",
    "ob.provider.finish": "Concluir configuração",
    "ob.field.baseUrl": "Base URL",
    "ob.field.model": "Modelo",
    "ob.field.timeout": "Timeout (s)",
    "ob.field.apiKey": "API Key",
    "ob.field.endpoint": "Endpoint",
    "ob.field.dims": "Densidade",
    "ob.test.connOk": "Conexão OK",
    "ob.test.fail": "Falha: {message}",
    "ob.rag.title": "Embeddings (RAG)",
    "ob.rag.sub.before": "Busca semântica do codebase. O sufixo",
    "ob.rag.sub.after": "é adicionado pelo client — configure só a base.",
    "ob.rag.dimsDefault": "padrão (1024)",
    "ob.rag.none": "Sem endpoint — recuperação lexical (BM25), 100% offline.",
    "ob.rag.ok": "Embeddings OK · {dims} dims",
    "ob.rag.test": "Testar embedding",
    "ob.foot.admin": "Observabilidade, skills e catálogo de MCP são geridos pelo admin.",
    "ob.foot.network": "Implantação em rede interna — sem conexão externa.",
    "ob.foot.secrets": "Licença e credenciais ficam no SecretStorage. Nada em settings.json.",
    "ob.status.configure": "FORGE · configurar",
    "ob.status.provider": "Provedor: definindo…",
    "md.code.lang": "código",
    "md.code.generating": "gerando…",
    "md.code.proposalCreated": "proposta criada",
    "md.code.saveTitle": "Salvar este código como um arquivo (vira uma proposta aplicável, com diff e gate)",
    "md.code.saveAsFile": "Salvar como arquivo",
    "md.code.copy": "Copiar",
    "md.code.copied": "Copiado",
    "md.code.newFile": "novo_arquivo.{ext}",
    "md.code.pathPlaceholder": "caminho/relativo/arquivo.ext",
    "md.code.confirmTitle": "Criar a proposta aplicável",
    "md.code.save": "Salvar",
    "md.code.cancel": "Cancelar",
    "charter.emptyDraft": "O modelo não retornou conteúdo para a seção. Tente de novo.",
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
    "ctx.title": "Context window",
    "ctx.colTokens": "tokens",
    "ctx.window": "Total window",
    "ctx.outputReserve": "Output reserve",
    "ctx.inputBudget": "Input budget",
    "ctx.pinned": "Fixed (chat prompt + profile)",
    "ctx.history": "History ({count, plural, one{# turn} other{# turns}})",
    "ctx.attachments": "Pending attachments ({count})",
    "ctx.estimate": "Estimated occupancy of the next send:",
    "ctx.rag": "RAG: {count, plural, one{# indexed chunk} other{# indexed chunks}} (added per query, within the budget)",
    "ctx.session": "Session: {input} input tokens · {output} output",
    "ctx.footnote": "Heuristic estimates (the real tokenizer varies; TDD/Project modes have a slightly larger fixed prompt). {clearCmd} clears the history.",
    "tok.title": "Token usage",
    "tok.empty": "No generation in this session yet — the numbers appear after the model's first response.",
    "tok.colIn": "input",
    "tok.colOut": "output",
    "tok.last": "Last generation",
    "tok.session": "Session (cumulative)",
    "tok.footnote": "Automatic continuations add to the generation total (each pass resends context).",
    "sum.title": "History compacted",
    "sum.body":
      "{turns, plural, one{# turn became} other{# turns became}} the summary below — THIS is what the model now receives as the conversation context (the thread above is display only; {clearCmd} resets everything).",
    "ob.subtitle": "initial setup",
    "ob.internalNetwork": "internal network",
    "ob.step.license": "License",
    "ob.step.provider": "Provider",
    "ob.license.title": "Activate license",
    "ob.license.sub": "Paste the key provided by the admin. The signature is verified locally (Ed25519) and confirmed on the server.",
    "ob.license.valid": "Valid signature · org {org} · expires on {expiry}",
    "ob.license.verify": "Verify and activate",
    "ob.email.label": "Your corporate e-mail (required)",
    "ob.email.placeholder": "you@claro.com.br",
    "ob.email.note": "The license does not identify you automatically. The e-mail is used as your identity in observability (Langfuse).",
    "ob.email.confirm": "Confirm e-mail",
    "ob.email.identified": "Identified as {email}",
    "ob.email.manual": "(entered manually)",
    "ob.provider.title": "Choose provider",
    "ob.provider.sub": "Select the model backend. HubGPU uses the OpenAI-compatible endpoint.",
    "ob.provider.test": "Test connection",
    "ob.provider.finishTitleEmail": "Enter your e-mail before finishing",
    "ob.provider.finishTitle": "Finish",
    "ob.provider.finish": "Finish setup",
    "ob.field.baseUrl": "Base URL",
    "ob.field.model": "Model",
    "ob.field.timeout": "Timeout (s)",
    "ob.field.apiKey": "API Key",
    "ob.field.endpoint": "Endpoint",
    "ob.field.dims": "Dimensions",
    "ob.test.connOk": "Connection OK",
    "ob.test.fail": "Failed: {message}",
    "ob.rag.title": "Embeddings (RAG)",
    "ob.rag.sub.before": "Semantic codebase search. The",
    "ob.rag.sub.after": "suffix is added by the client — configure only the base.",
    "ob.rag.dimsDefault": "default (1024)",
    "ob.rag.none": "No endpoint — lexical retrieval (BM25), 100% offline.",
    "ob.rag.ok": "Embeddings OK · {dims} dims",
    "ob.rag.test": "Test embedding",
    "ob.foot.admin": "Observability, skills and the MCP catalog are admin-managed.",
    "ob.foot.network": "Internal-network deployment — no external connection.",
    "ob.foot.secrets": "License and credentials live in SecretStorage. Nothing in settings.json.",
    "ob.status.configure": "FORGE · configure",
    "ob.status.provider": "Provider: choosing…",
    "md.code.lang": "code",
    "md.code.generating": "generating…",
    "md.code.proposalCreated": "proposal created",
    "md.code.saveTitle": "Save this code as a file (it becomes an applicable proposal, with diff and gate)",
    "md.code.saveAsFile": "Save as file",
    "md.code.copy": "Copy",
    "md.code.copied": "Copied",
    "md.code.newFile": "new_file.{ext}",
    "md.code.pathPlaceholder": "relative/path/file.ext",
    "md.code.confirmTitle": "Create the applicable proposal",
    "md.code.save": "Save",
    "md.code.cancel": "Cancel",
    "charter.emptyDraft": "The model returned no content for the section. Try again.",
  },
};
