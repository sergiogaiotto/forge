// Paleta "/" do FORGE: registry declarativo dos comandos do composer + matching e renderizações
// PURAS (testáveis pelo host via tsx, como markdown.ts/state.ts). A EXECUÇÃO (post/dispatch) fica no
// DevPanel — aqui não entra React nem VS Code. Matching normaliza acentos: /sumário ≡ /sumario.
import type { ContextReport } from "../../src/shared/protocol";
import { getLocale } from "./i18n";
import { t } from "./i18n";

export interface SlashCommand {
  id: string; // canônico, sem acento (ex.: "limpar")
  label: string; // como aparece na paleta (ex.: "/limpar")
  hint: string; // uma linha: o que faz
  icon: string; // nome do Icon da webview
  aliases?: string[]; // formas alternativas (sem "/"), já sem acento
  // Comando que ACEITA argumentos após o nome (ex.: "/diagrama fluxo de dados"). A regra
  // anti-sequestro (cauda = mensagem do dev) NÃO vale para estes: a cauda é o argumento esperado.
  acceptsArgs?: boolean;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { id: "ajuda", label: "/ajuda", hint: "Lista os comandos da paleta", icon: "info-circle", aliases: ["help", "?"] },
  { id: "contexto", label: "/contexto", hint: "Orçamento da janela de contexto (modelo, reservas, histórico, RAG)", icon: "database", aliases: ["context"] },
  { id: "tokens", label: "/tokens", hint: "Uso de tokens da sessão (última geração + acumulado)", icon: "activity" },
  { id: "limpar", label: "/limpar", hint: "Limpa a conversa DE VERDADE (histórico e anexos do host)", icon: "history", aliases: ["clear"] },
  { id: "ambiente", label: "/ambiente", hint: "Prepara o ambiente Python (venv + dependências)", icon: "plug", aliases: ["env"] },
  { id: "testes", label: "/testes", hint: "Roda a suíte de testes (instala o pytest se faltar)", icon: "terminal", aliases: ["test", "tests"] },
  { id: "perfil", label: "/perfil", hint: "Abre o Perfil do projeto (stack, papel, regras)", icon: "users", aliases: ["profile"] },
  { id: "indice", label: "/indice", hint: "Abre o Índice (skills + RAG que o FORGE injeta)", icon: "database", aliases: ["index"] },
  { id: "projeto", label: "/projeto", hint: "Liga/desliga o Modo Projeto (blueprint aprovável)", icon: "list-check", aliases: ["project"] },
  { id: "revisar", label: "/revisar", hint: "Revisão multi-lente das alterações do workspace (git diff)", icon: "git-compare", aliases: ["review"] },
  { id: "resumir", label: "/resumir", hint: "Compacta o histórico da conversa num resumo (libera a janela)", icon: "copy", aliases: ["compactar", "summarize"] },
  { id: "diagrama", label: "/diagrama", hint: "Gera diagrama Mermaid da codebase (proposta em docs/diagramas/)", icon: "network", aliases: ["diagram", "mermaid"], acceptsArgs: true },
  {
    id: "sumario",
    label: "/sumário projeto",
    hint: "Documentação funcional do projeto, padrão de mercado (proposta em docs/SUMARIO_FUNCIONAL.md)",
    icon: "file-code",
    aliases: ["sumario-projeto", "summary"],
    acceptsArgs: true, // aceita a forma completa "/sumário projeto" (a cauda é ignorada)
  },
  {
    id: "impacto",
    label: "/impacto",
    hint: "Raio de explosão da mudança (lineage do manifest dbt: downstream, testes, exposures)",
    icon: "network",
    aliases: ["impact", "blast"],
    acceptsArgs: true, // cauda = nome do modelo; sem cauda usa o arquivo ativo
  },
  {
    id: "traduzir-sql",
    label: "/traduzir-sql",
    hint: "Traduz o SQL do arquivo ativo para outro dialeto (proposta .sql validada pelo motor)",
    icon: "git-compare",
    aliases: ["translate-sql", "traduzir"],
    acceptsArgs: true, // cauda = dialeto alvo (bigquery, snowflake, postgres, spark, oracle…)
  },
  {
    id: "conexoes",
    label: "/conexoes",
    hint: "Lista e testa as conexões de warehouse (Oracle, PostgreSQL, BigQuery, DuckDB, S3/OCI)",
    icon: "plug",
    aliases: ["connections", "warehouses"],
  },
  {
    id: "executar-sql",
    label: "/executar-sql",
    hint: "Executa o .sql ativo na conexão (SELECT direto; escrita confirma; DROP/TRUNCATE nunca)",
    icon: "terminal",
    aliases: ["run-sql", "rodar-sql"],
    acceptsArgs: true, // cauda = id da conexão; sem cauda usa a default
  },
  {
    id: "schema-db",
    label: "/schema-db",
    hint: "Indexa o schema REAL do warehouse (grounding: entra no prompt e no gate semântico)",
    icon: "database",
    aliases: ["schema-warehouse"],
    acceptsArgs: true, // cauda = id da conexão
  },
  {
    id: "paridade",
    label: "/paridade",
    hint: "Compara duas tabelas por agregados (compliance-safe) — intra ou entre warehouses",
    icon: "git-compare",
    aliases: ["parity", "data-diff"],
    acceptsArgs: true, // "tabela_a tabela_b" (opcional conexao:tabela em cada lado)
  },
  {
    id: "custo",
    label: "/custo",
    hint: "Custo: prévia da consulta ativa (dry-run/EXPLAIN) ou top consultas dos últimos 7 dias",
    icon: "activity",
    aliases: ["cost", "finops"],
    acceptsArgs: true, // cauda = id da conexão
  },
  {
    id: "auditoria-pii",
    label: "/auditoria-pii",
    hint: "Auditoria LGPD por nome de coluna no schema indexado (dbt + warehouse) — 100% local",
    icon: "users",
    aliases: ["pii", "lgpd", "audit-pii"],
  },
  {
    id: "testes-dbt",
    label: "/testes-dbt",
    hint: "Gera testes dbt (schema.yml) para um modelo, com as colunas REAIS do manifest",
    icon: "list-check",
    aliases: ["dbt-tests", "testes-modelo"],
    acceptsArgs: true, // cauda = nome do modelo; sem cauda usa o arquivo ativo
  },
  { id: "git-status", label: "/git-status", hint: "Status do repositório (branch, arquivos modificados, à frente/atrás)", icon: "git-compare", aliases: ["gs", "status-git"] },
  { id: "git-diff", label: "/git-diff", hint: "Diferenças do working tree vs. o último commit (HEAD)", icon: "git-compare", aliases: ["gd", "diff-git"] },
  { id: "git-log", label: "/git-log", hint: "Últimos commits (hash, autor, quando, assunto)", icon: "history", aliases: ["gl", "log-git"] },
  {
    id: "git-commit",
    label: "/git-commit",
    hint: 'Commita os arquivos RASTREADOS modificados (confirmação obrigatória). Uso: /git-commit "mensagem"',
    icon: "check",
    aliases: ["gc", "commit"],
    acceptsArgs: true, // cauda = mensagem do commit
  },
];

// Override EN de label/hint por id de comando. O array acima é a FONTE pt-BR (o `id`/`aliases` — as
// chaves de matching — NUNCA mudam); aqui só o TEXTO exibido em inglês. Os labels en batem com o alias
// en primário quando existe (ex.: "/clear" ≡ alias "clear"), então o matching continua valendo nos dois
// idiomas. commandLabel/commandHint resolvem pelo locale ativo.
const COMMAND_EN: Record<string, { label: string; hint: string }> = {
  ajuda: { label: "/help", hint: "List the palette commands" },
  contexto: { label: "/context", hint: "Context window budget (model, reserves, history, RAG)" },
  tokens: { label: "/tokens", hint: "Session token usage (last generation + cumulative)" },
  limpar: { label: "/clear", hint: "Clear the conversation FOR REAL (host history and attachments)" },
  ambiente: { label: "/env", hint: "Prepare the Python environment (venv + dependencies)" },
  testes: { label: "/tests", hint: "Run the test suite (installs pytest if missing)" },
  perfil: { label: "/profile", hint: "Open the project Profile (stack, role, rules)" },
  indice: { label: "/index", hint: "Open the Index (skills + RAG that FORGE injects)" },
  projeto: { label: "/project", hint: "Toggle Project Mode (approvable blueprint)" },
  revisar: { label: "/review", hint: "Multi-lens review of workspace changes (git diff)" },
  resumir: { label: "/summarize", hint: "Compact the conversation history into a summary (frees the window)" },
  diagrama: { label: "/diagram", hint: "Generate a Mermaid diagram of the codebase (proposal in docs/diagramas/)" },
  sumario: { label: "/summary project", hint: "Functional project documentation, market-standard (proposal in docs/SUMARIO_FUNCIONAL.md)" },
  impacto: { label: "/impact", hint: "Blast radius of the change (dbt manifest lineage: downstream, tests, exposures)" },
  "traduzir-sql": { label: "/translate-sql", hint: "Translate the active file's SQL to another dialect (a .sql proposal validated by the engine)" },
  conexoes: { label: "/connections", hint: "List and test the warehouse connections (Oracle, PostgreSQL, BigQuery, DuckDB, S3/OCI)" },
  "executar-sql": { label: "/run-sql", hint: "Run the active .sql on the connection (SELECT directly; writes confirm; DROP/TRUNCATE never)" },
  "schema-db": { label: "/schema-db", hint: "Index the REAL warehouse schema (grounding: enters the prompt and the semantic gate)" },
  paridade: { label: "/parity", hint: "Compare two tables by aggregates (compliance-safe) — intra or cross-warehouse" },
  custo: { label: "/cost", hint: "Cost: preview of the active query (dry-run/EXPLAIN) or top queries of the last 7 days" },
  "auditoria-pii": { label: "/audit-pii", hint: "LGPD audit by column name over the indexed schema (dbt + warehouse) — 100% local" },
  "testes-dbt": { label: "/dbt-tests", hint: "Generate dbt tests (schema.yml) for a model, with the REAL columns from the manifest" },
  "git-status": { label: "/git-status", hint: "Repository status (branch, modified files, ahead/behind)" },
  "git-diff": { label: "/git-diff", hint: "Working tree diff vs. the last commit (HEAD)" },
  "git-log": { label: "/git-log", hint: "Latest commits (hash, author, when, subject)" },
  "git-commit": { label: "/git-commit", hint: 'Commit the modified TRACKED files (confirmation required). Usage: /git-commit "message"' },
};

// Label/hint EXIBIDOS do comando, resolvidos pelo locale ativo (pt-BR = a fonte do array; en = override).
export function commandLabel(cmd: SlashCommand): string {
  return getLocale() === "en" ? COMMAND_EN[cmd.id]?.label ?? cmd.label : cmd.label;
}
export function commandHint(cmd: SlashCommand): string {
  return getLocale() === "en" ? COMMAND_EN[cmd.id]?.hint ?? cmd.hint : cmd.hint;
}

// Normalização para matching: minúsculas + remoção de diacríticos (á→a, ç→c) — o dev digita
// "/sumário" ou "/sumario" e ambos casam.
export function normalizeSlash(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

// Comandos cujo id/alias/label COMEÇA com o que foi digitado (sem a "/"). Entrada vazia = todos.
export function matchSlashCommands(input: string, registry: SlashCommand[] = SLASH_COMMANDS): SlashCommand[] {
  if (!input.startsWith("/")) return [];
  const q = normalizeSlash(input.slice(1).trim().split(/\s+/)[0] ?? "");
  if (!q) return registry;
  return registry.filter((c) => c.id.startsWith(q) || (c.aliases ?? []).some((a) => normalizeSlash(a).startsWith(q)));
}

// O texto digitado é EXATAMENTE um comando? ("/limpar", sem NADA depois). Texto com cauda
// ("/testes estão falhando — por quê?") NÃO é comando: é uma mensagem do dev que começa com "/" —
// executar a suíte e descartar a pergunta seria sequestro (confirmado em revisão adversarial).
export function exactSlashCommand(input: string, registry: SlashCommand[] = SLASH_COMMANDS): SlashCommand | undefined {
  if (!input.startsWith("/")) return undefined;
  const trimmed = input.trim();
  if (/\s/.test(trimmed)) return undefined; // qualquer cauda (espaço/linha) → não é comando
  const head = normalizeSlash(trimmed.slice(1));
  if (!head) return undefined;
  return registry.find((c) => c.id === head || (c.aliases ?? []).some((a) => normalizeSlash(a) === head));
}

// Cauda da FORMA COMPLETA de um comando: as palavras do label DEPOIS da primeira (ex.: "/sumário
// projeto" → "projeto"). Deriva a palavra esperada do PRÓPRIO label (fonte única) — assim traduzir o
// label ("/summary project") atualiza a comparação automaticamente, sem um literal pt-BR hardcoded no
// controle (que quebraria em silêncio após a tradução). "" se o label tem só uma palavra.
export function slashFullFormTail(label: string): string {
  const words = label.replace(/^\//, "").trim().split(/\s+/);
  return words.length > 1 ? normalizeSlash(words.slice(1).join(" ")) : "";
}

// Comando COM argumentos: o 1º token casa um comando acceptsArgs e a cauda vira o argumento
// ("/diagrama fluxo de autenticação" → { cmd: diagrama, args: "fluxo de autenticação" }).
export function slashWithArgs(
  input: string,
  registry: SlashCommand[] = SLASH_COMMANDS
): { cmd: SlashCommand; args: string } | undefined {
  if (!input.startsWith("/")) return undefined;
  const trimmed = input.trim();
  const m = /^\/(\S+)\s+([\s\S]+)$/.exec(trimmed);
  if (!m) return undefined;
  const head = normalizeSlash(m[1]);
  const cmd = registry.find((c) => c.acceptsArgs && (c.id === head || (c.aliases ?? []).some((a) => normalizeSlash(a) === head)));
  return cmd ? { cmd, args: m[2].trim() } : undefined;
}

// Prompt do /diagrama: gera o diagrama como PROPOSTA de arquivo versionável (docs/diagramas/) —
// reusa todo o pipeline de propostas/aplicação; o dev revisa o Mermaid no diff e aplica.
export function buildDiagramRequest(theme: string): string {
  const t = theme.trim() || "arquitetura do projeto";
  const slug = normalizeSlash(t).replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 60) || "arquitetura";
  return [
    `Gere um DIAGRAMA Mermaid do codebase atual com o tema: ${t}.`,
    "Analise a estrutura real do projeto (o contexto fornecido traz os arquivos indexados) e produza",
    `UM único arquivo \`docs/diagramas/${slug}.md\` como bloco forge-file completo, contendo:`,
    "1. Um título e 1–2 frases do que o diagrama mostra;",
    "2. UM bloco ```mermaid válido (graph TD/LR, flowchart, sequence ou class — o que melhor couber ao tema),",
    "   com nós nomeados pelos MÓDULOS/ARQUIVOS reais do projeto (não invente componentes);",
    "3. Uma legenda curta explicando os agrupamentos.",
    "NÃO gere nenhum outro arquivo. NÃO modifique código.",
  ].join("\n");
}

// Prompt do "/sumário projeto": DOCUMENTAÇÃO FUNCIONAL padrão de mercado, gerada do código real +
// charter, como PROPOSTA de arquivo versionável — o dev revisa o markdown no diff e aplica.
// `todayIso` injetável (default = hoje): o MODELO não tem relógio — sem a data no prompt, o
// Histórico de Revisões sairia com data fabricada e confiante (pior que sem data).
export function buildProjectSummaryRequest(todayIso: string = new Date().toISOString().slice(0, 10)): string {
  return [
    "Gere a DOCUMENTAÇÃO FUNCIONAL deste projeto, no padrão de mercado, analisando o código REAL",
    "(o contexto fornecido traz a stack detectada, o charter do projeto e os arquivos indexados).",
    "Produza UM único arquivo `docs/SUMARIO_FUNCIONAL.md` como bloco forge-file completo, com EXATAMENTE estas seções:",
    "1. **Visão Geral e Objetivo de Negócio** — o que o sistema faz, para quem e qual valor entrega;",
    "2. **Escopo** — o que está dentro e o que está explicitamente fora;",
    "3. **Personas e Usuários** — quem usa e com que objetivo;",
    "4. **Funcionalidades** — tabela: código (F-01…), nome, descrição, prioridade (SÓ quando o charter a declarar; senão 'n/d' — não invente);",
    "5. **Fluxos Principais** — passo a passo dos 2-3 fluxos centrais + UM diagrama ```mermaid (flowchart ou sequence);",
    "6. **Arquitetura e Módulos** — camadas/módulos REAIS do código (caminhos), responsabilidade de cada um;",
    "7. **Modelo de Dados** — entidades e relações (do código real; se não houver persistência, diga);",
    "8. **Requisitos Funcionais e Não Funcionais** — herde do charter quando existir; senão, derive do código e marque como inferido;",
    "9. **Integrações e Dependências** — externas (APIs, bancos, filas) e principais bibliotecas;",
    "10. **Como Executar** — comandos reais, na ordem, em blocos de shell copiáveis;",
    "11. **Glossário** — termos do domínio;",
    `12. **Histórico de Revisões** — tabela iniciada com a versão 1.0 (data ${todayIso}, autor FORGE).`,
    "Seja FIEL ao código: cite caminhos reais, não invente funcionalidades. Seções sem evidência no código",
    "devem dizer 'não identificado no código' em vez de especular. NÃO gere nenhum outro arquivo.",
  ].join("\n");
}

// Dialetos que o /traduzir-sql aceita como alvo (validação leve client-side; o motor SQL do host
// valida o RESULTADO da tradução como qualquer proposta .sql).
export const SQL_DIALECTS = [
  "postgres", "mysql", "bigquery", "snowflake", "redshift", "oracle", "sqlserver", "tsql",
  "spark", "databricks", "duckdb", "trino", "hive", "sqlite",
];

// Prompt do /traduzir-sql <dialeto>: tradução com PRESERVAÇÃO SEMÂNTICA explícita (o padrão CAN/CANNOT
// das skills de dados) — na dúvida o modelo mantém e avisa, nunca "otimiza" mudando resultado. A saída
// é proposta .sql normal: o motor SQL determinístico do host a valida (parse, anti-padrões, schema).
export function buildSqlTranslateRequest(dialect: string): string {
  const d = dialect.trim().toLowerCase();
  return [
    `Traduza o SQL do ARQUIVO ATIVO (fornecido no contexto como "Arquivo aberto") para o dialeto ${d.toUpperCase()}.`,
    "Pré-condições — verifique ANTES de traduzir:",
    "- Se o contexto NÃO trouxer o bloco \"Arquivo aberto\", ou se o conteúdo dele não for SQL, diga isso e PARE — não invente um arquivo;",
    "- Se o bloco \"Arquivo aberto\" contiver o marcador de truncamento (\"… (truncado)\"), NÃO traduza — avise que o arquivo excede o limite do contexto e peça para dividir.",
    "Regras INEGOCIÁVEIS de preservação semântica:",
    "1. O resultado deve retornar EXATAMENTE as mesmas linhas/colunas — traduza sintaxe, NUNCA \"otimize\" a lógica;",
    "2. Funções sem equivalente direto: use a construção idiomática do dialeto alvo e ADICIONE um comentário `-- TRADUÇÃO:` explicando a troca;",
    "3. Se algum trecho NÃO tem tradução segura (semântica pode mudar), mantenha o original nesse trecho com um comentário `-- REVISAR:` — não invente;",
    "4. Preserve nomes de tabelas/colunas e a formatação geral (CTEs continuam CTEs).",
    `Produza UM único bloco forge-file com o arquivo traduzido ao lado do original: mesmo diretório, sufixo .${d}.sql`,
    "(ex.: consultas/relatorio.sql → consultas/relatorio." + d + ".sql). NÃO modifique o arquivo original.",
    "Após o bloco, liste em 2-4 bullets o que mudou de sintaxe e qualquer `-- REVISAR:` pendente.",
  ].join("\n");
}

// Prompt do /testes-dbt [modelo]: gera/estende o schema.yml com a taxonomia coluna→teste, ancorado nas
// colunas REAIS (o host injeta o "Schema real do projeto dbt" no contexto — o prompt PROÍBE inventar).
export function buildDbtTestsRequest(model: string): string {
  const alvo = model.trim()
    ? `o modelo dbt \`${model.trim()}\``
    : "o modelo dbt do ARQUIVO ATIVO (fornecido no contexto como \"Arquivo aberto\")";
  return [
    `Gere os TESTES dbt (schema.yml) para ${alvo}.`,
    "Use SOMENTE as colunas do bloco \"Schema real do projeto dbt\" do contexto — se o bloco não tiver o modelo,",
    "diga isso e PARE (peça para rodar `dbt parse`); NUNCA invente nomes de coluna.",
    "Taxonomia (aplique o que couber, coluna a coluna):",
    "- chave primária / id único → `unique` + `not_null`;",
    "- chave estrangeira (sufixo _id que referencia outro modelo do schema) → `not_null` + `relationships` (to: ref('<modelo>'), field: <coluna>);",
    "- colunas de status/categoria com domínio pequeno e ÓBVIO → `accepted_values` com um comentário `# TODO: confirmar domínio com o negócio` (nunca invente valores silenciosamente);",
    "- colunas de data/timestamp essenciais ao grain → `not_null`.",
    "Regras: siga o ESTILO dos schema.yml já existentes no projeto (indentação, ordem, pacotes de teste em uso —",
    "NÃO introduza dbt_utils se o projeto não o usa); todo modelo sai com pelo menos 1 teste; documente o grain",
    "na description do modelo (uma linha, o PORQUÊ).",
    "Produza UM único bloco forge-file com o schema.yml no MESMO diretório do modelo (se já existir um",
    "schema.yml/models.yml lá, produza o arquivo COMPLETO atualizado com o novo modelo adicionado).",
  ].join("\n");
}

// Cartão do /resumir: confirma a compactação do histórico do HOST (a thread visível não muda).
export function renderSummarized(turns: number, summary: string): string {
  const s = turns === 1 ? "" : "s";
  return `### Histórico compactado\n\n${turns} turno${s} ${turns === 1 ? "virou" : "viraram"} o resumo abaixo — é ISTO que o modelo passa a receber como contexto da conversa (a thread acima é só exibição; \`/limpar\` zera tudo).\n\n---\n\n${summary}`;
}

const fmtK = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

// Barra visual de ocupação em texto (12 células) — renderiza bem no <Markdown> monoespaçado.
function bar(used: number, total: number): string {
  if (total <= 0) return "";
  const cells = 12;
  const filled = Math.max(0, Math.min(cells, Math.round((used / total) * cells)));
  return `\`${"█".repeat(filled)}${"░".repeat(cells - filled)}\` ${Math.round((used / total) * 100)}%`;
}

// Cartão markdown do /contexto — o relatório vem do HOST (números do MESMO deriveBudget da geração).
export function renderContextReport(r: ContextReport): string {
  // Ocupação do PRÓXIMO envio: fixo + histórico + anexos pendentes (entram inteiros no envio).
  const estimated = r.pinnedTokens + r.historyTokens + r.attachmentTokens;
  const attach =
    r.attachments > 0 ? `| Anexos pendentes (${r.attachments}) | ~${fmtK(r.attachmentTokens)} |` : "";
  return [
    `### Janela de contexto · ${r.modelId}`,
    "",
    `| | tokens |`,
    `|---|---|`,
    `| Janela total | ${fmtK(r.contextWindow)} |`,
    `| Reserva de saída | ${fmtK(r.outputReserve)} |`,
    `| Orçamento de entrada | ${fmtK(r.inputBudget)} |`,
    `| Fixo (prompt do chat + perfil) | ~${fmtK(r.pinnedTokens)} |`,
    `| Histórico (${r.historyTurns} turno${r.historyTurns === 1 ? "" : "s"}) | ~${fmtK(r.historyTokens)} |`,
    ...(attach ? [attach] : []),
    "",
    `Ocupação estimada do próximo envio: ${bar(estimated, r.inputBudget)}`,
    "",
    `RAG: ${r.ragChunks} chunk${r.ragChunks === 1 ? "" : "s"} indexado${r.ragChunks === 1 ? "" : "s"} (entram por consulta, conforme o orçamento)`,
    `Sessão: ${fmtK(r.sessionInputTokens)} tokens de entrada · ${fmtK(r.sessionOutputTokens)} de saída`,
    "",
    `_Estimativas heurísticas (o tokenizer real varia; TDD/Projeto têm prompt fixo um pouco maior). \`/limpar\` zera o histórico._`,
  ].join("\n");
}

// Cartão markdown do /tokens — dados locais da webview (usage do stream/end + acumulado da sessão).
export function renderTokensReport(u: { lastIn: number; lastOut: number; sessionIn: number; sessionOut: number } | null): string {
  if (!u || (u.sessionIn === 0 && u.sessionOut === 0)) {
    return "### Uso de tokens\n\nAinda não houve geração nesta sessão — os números aparecem após a primeira resposta do modelo.";
  }
  return [
    "### Uso de tokens",
    "",
    "| | entrada | saída |",
    "|---|---|---|",
    `| Última geração | ${fmtK(u.lastIn)} | ${fmtK(u.lastOut)} |`,
    `| Sessão (acumulado) | ${fmtK(u.sessionIn)} | ${fmtK(u.sessionOut)} |`,
    "",
    "_Continuações automáticas somam no acumulado da geração (cada passe reenvia contexto)._",
  ].join("\n");
}

// Cartão markdown do /ajuda.
export function renderHelp(registry: SlashCommand[] = SLASH_COMMANDS): string {
  const rows = registry.map((c) => `| \`${commandLabel(c)}\` | ${commandHint(c)} |`);
  return [`### ${t("help.title")}`, "", `| ${t("help.colCommand")} | ${t("help.colWhat")} |`, "|---|---|", ...rows, "", `_${t("help.footer")}_`].join("\n");
}
