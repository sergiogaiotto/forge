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
  { id: "ajuda", label: "/ajuda", hint: "Lista os comandos da paleta", icon: "info-circle", aliases: ["help", "?", "ayuda"] },
  { id: "contexto", label: "/contexto", hint: "Orçamento da janela de contexto (modelo, reservas, histórico, RAG)", icon: "database", aliases: ["context"] },
  { id: "tokens", label: "/tokens", hint: "Uso de tokens da sessão (última geração + acumulado)", icon: "activity" },
  { id: "limpar", label: "/limpar", hint: "Limpa a conversa DE VERDADE (histórico e anexos do host)", icon: "history", aliases: ["clear", "limpiar"] },
  { id: "ambiente", label: "/ambiente", hint: "Prepara o ambiente Python (venv + dependências)", icon: "plug", aliases: ["env", "entorno"] },
  { id: "notebook", label: "/notebook", hint: "Prepara .venv, ipykernel e o seletor de kernel Jupyter", icon: "file-code", aliases: ["jupyter", "cuaderno"] },
  { id: "venv", label: "/venv", hint: "Ativa o ambiente Python do projeto em um terminal dedicado", icon: "terminal", aliases: ["activate-venv", "activar-venv"] },
  { id: "readme", label: "/readme", hint: "Cria ou atualiza um README.md completo como proposta revisável", icon: "file-code" },
  { id: "testes", label: "/testes", hint: "Roda a suíte de testes (instala o pytest se faltar)", icon: "terminal", aliases: ["test", "tests", "pruebas"] },
  { id: "perfil", label: "/perfil", hint: "Abre o Perfil do projeto (stack, papel, regras)", icon: "users", aliases: ["profile"] },
  { id: "indice", label: "/indice", hint: "Abre o Índice (skills + RAG que o FORGE injeta)", icon: "database", aliases: ["index"] },
  { id: "projeto", label: "/projeto", hint: "Liga/desliga o Modo Projeto (blueprint aprovável)", icon: "list-check", aliases: ["project", "proyecto"] },
  { id: "revisar", label: "/revisar", hint: "Revisão multi-lente das alterações do workspace (git diff)", icon: "git-compare", aliases: ["review"] },
  { id: "resumir", label: "/resumir", hint: "Compacta o histórico da conversa num resumo (libera a janela)", icon: "copy", aliases: ["compactar", "summarize"] },
  { id: "diagrama", label: "/diagrama", hint: "Gera diagrama Mermaid da codebase (proposta em docs/diagramas/)", icon: "network", aliases: ["diagram", "mermaid"], acceptsArgs: true },
  {
    id: "sumario",
    label: "/sumário projeto",
    hint: "Documentação funcional do projeto, padrão de mercado (proposta em docs/SUMARIO_FUNCIONAL.md)",
    icon: "file-code",
    aliases: ["sumario-projeto", "summary", "resumen"],
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
    aliases: ["translate-sql", "traduzir", "traducir-sql", "traducir"],
    acceptsArgs: true, // cauda = dialeto alvo (bigquery, snowflake, postgres, spark, oracle…)
  },
  {
    id: "sql-lab",
    label: "/sql-lab",
    hint: "Abre o laboratório SQL local com DuckDB embutido, persistente e governado",
    icon: "database",
    aliases: ["lab-sql"],
  },
  {
    id: "importar-schema",
    label: "/importar-schema",
    hint: "Importa CREATE TABLE, chaves e índices de um arquivo DDL para o grounding local",
    icon: "folder",
    aliases: ["import-schema", "importar-esquema"],
    acceptsArgs: true,
  },
  {
    id: "validar-sql",
    label: "/validar-sql",
    hint: "Valida segurança, anti-padrões, schema e compatibilidade do dialeto",
    icon: "list-check",
    aliases: ["validate-sql"],
    acceptsArgs: true,
  },
  {
    id: "plano-sql",
    label: "/plano-sql",
    hint: "Cockpit estimado: EXPLAIN/dry-run, métricas e hotspots sem executar a consulta",
    icon: "activity",
    aliases: ["explain-sql", "plan-sql"],
    acceptsArgs: true,
  },
  {
    id: "analisar-sql",
    label: "/analisar-sql",
    hint: "Executa o SELECT com consentimento e mede tempo, buffers e cardinalidade real",
    icon: "pulse",
    aliases: ["analyze-sql", "analise-sql", "analizar-sql"],
    acceptsArgs: true,
  },
  {
    id: "comparar-sql",
    label: "/comparar-sql",
    hint: "Compara o plano do *.tuned.sql com o arquivo original, sem executar ambos",
    icon: "git-compare",
    aliases: ["compare-sql", "comparar-planos", "comparar-sql"],
    acceptsArgs: true,
  },
  {
    id: "tunar-sql",
    label: "/tunar-sql",
    hint: "Gera uma proposta otimizada usando plano real, dialeto e schema indexado",
    icon: "git-compare",
    aliases: ["tune-sql", "otimizar-sql", "optimizar-sql"],
    acceptsArgs: true,
  },
  {
    id: "conexoes",
    label: "/conexoes",
    hint: "Lista e testa as conexões de warehouse (Oracle, PostgreSQL, BigQuery, DuckDB, S3/OCI)",
    icon: "plug",
    aliases: ["connections", "warehouses", "conexiones"],
  },
  {
    id: "executar-sql",
    label: "/executar-sql",
    hint: "Executa o .sql ativo na conexão (SELECT direto; escrita confirma; DROP/TRUNCATE nunca)",
    icon: "terminal",
    aliases: ["run-sql", "rodar-sql", "ejecutar-sql"],
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
    aliases: ["parity", "data-diff", "paridad"],
    acceptsArgs: true, // "tabela_a tabela_b" (opcional conexao:tabela em cada lado)
  },
  {
    id: "custo",
    label: "/custo",
    hint: "Custo: prévia da consulta ativa (dry-run/EXPLAIN) ou top consultas dos últimos 7 dias",
    icon: "activity",
    aliases: ["cost", "finops", "costo"],
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
    aliases: ["dbt-tests", "testes-modelo", "pruebas-dbt"],
    acceptsArgs: true, // cauda = nome do modelo; sem cauda usa o arquivo ativo
  },
  {
    id: "arquivos",
    label: "/arquivos",
    hint: "Lista os arquivos do workspace (navegação governada — só leitura)",
    icon: "folder",
    aliases: ["files", "ls", "archivos"],
    acceptsArgs: true, // cauda = filtro de pasta (prefixo de caminho)
  },
  {
    id: "buscar",
    label: "/buscar",
    hint: "Busca por regex nos arquivos do workspace (local, só leitura; linhas mascaradas)",
    icon: "search",
    aliases: ["search", "grep"],
    acceptsArgs: true, // cauda = o padrão (regex)
  },
  {
    id: "todos",
    label: "/todos",
    hint: "Lista os TODO/FIXME/HACK/XXX do workspace (varredura local determinística)",
    icon: "list-check",
    aliases: ["todo", "fixme"],
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
export const COMMAND_EN: Record<string, { label: string; hint: string }> = {
  ajuda: { label: "/help", hint: "List the palette commands" },
  contexto: { label: "/context", hint: "Context window budget (model, reserves, history, RAG)" },
  tokens: { label: "/tokens", hint: "Session token usage (last generation + cumulative)" },
  limpar: { label: "/clear", hint: "Clear the conversation FOR REAL (host history and attachments)" },
  ambiente: { label: "/env", hint: "Prepare the Python environment (venv + dependencies)" },
  notebook: { label: "/notebook", hint: "Prepare .venv, ipykernel, and the Jupyter kernel picker" },
  venv: { label: "/venv", hint: "Activate the project's Python environment in a dedicated terminal" },
  readme: { label: "/readme", hint: "Create or update a complete README.md as a reviewable proposal" },
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
  "sql-lab": { label: "/sql-lab", hint: "Open the governed, persistent local SQL lab with embedded DuckDB" },
  "importar-schema": { label: "/import-schema", hint: "Import CREATE TABLE statements, keys, and indexes from a DDL file into local grounding" },
  "validar-sql": { label: "/validate-sql", hint: "Validate safety, anti-patterns, schema, and dialect compatibility" },
  "plano-sql": { label: "/explain-sql", hint: "Estimated cockpit: EXPLAIN/dry-run, metrics, and hotspots without running the query" },
  "analisar-sql": { label: "/analyze-sql", hint: "Execute the SELECT with consent and measure actual time, buffers, and cardinality" },
  "comparar-sql": { label: "/compare-sql", hint: "Compare the *.tuned.sql plan with its original without executing both" },
  "tunar-sql": { label: "/tune-sql", hint: "Generate an optimized proposal from the real plan, dialect, and indexed schema" },
  conexoes: { label: "/connections", hint: "List and test the warehouse connections (Oracle, PostgreSQL, BigQuery, DuckDB, S3/OCI)" },
  "executar-sql": { label: "/run-sql", hint: "Run the active .sql on the connection (SELECT directly; writes confirm; DROP/TRUNCATE never)" },
  "schema-db": { label: "/schema-db", hint: "Index the REAL warehouse schema (grounding: enters the prompt and the semantic gate)" },
  paridade: { label: "/parity", hint: "Compare two tables by aggregates (compliance-safe) — intra or cross-warehouse" },
  custo: { label: "/cost", hint: "Cost: preview of the active query (dry-run/EXPLAIN) or top queries of the last 7 days" },
  "auditoria-pii": { label: "/audit-pii", hint: "LGPD audit by column name over the indexed schema (dbt + warehouse) — 100% local" },
  "testes-dbt": { label: "/dbt-tests", hint: "Generate dbt tests (schema.yml) for a model, with the REAL columns from the manifest" },
  arquivos: { label: "/files", hint: "List the workspace files (governed browsing — read-only)" },
  buscar: { label: "/search", hint: "Regex search across workspace files (local, read-only; lines masked)" },
  todos: { label: "/todos", hint: "List the workspace TODO/FIXME/HACK/XXX markers (deterministic local scan)" },
  "git-status": { label: "/git-status", hint: "Repository status (branch, modified files, ahead/behind)" },
  "git-diff": { label: "/git-diff", hint: "Working tree diff vs. the last commit (HEAD)" },
  "git-log": { label: "/git-log", hint: "Latest commits (hash, author, when, subject)" },
  "git-commit": { label: "/git-commit", hint: 'Commit the modified TRACKED files (confirmation required). Usage: /git-commit "message"' },
};

// Override ES (mesmo contrato do COMMAND_EN: só TEXTO; id/aliases nunca mudam — todo label es tem um
// alias correspondente no array, exigido pelo guard de matching).
export const COMMAND_ES: Record<string, { label: string; hint: string }> = {
  ajuda: { label: "/ayuda", hint: "Lista los comandos de la paleta" },
  contexto: { label: "/contexto", hint: "Presupuesto de la ventana de contexto (modelo, reservas, historial, RAG)" },
  tokens: { label: "/tokens", hint: "Uso de tokens de la sesión (última generación + acumulado)" },
  limpar: { label: "/limpiar", hint: "Limpia la conversación DE VERDAD (historial y adjuntos del host)" },
  ambiente: { label: "/entorno", hint: "Prepara el entorno Python (venv + dependencias)" },
  notebook: { label: "/notebook", hint: "Prepara .venv, ipykernel y el selector de kernel Jupyter" },
  venv: { label: "/venv", hint: "Activa el entorno Python del proyecto en una terminal dedicada" },
  readme: { label: "/readme", hint: "Crea o actualiza un README.md completo como propuesta revisable" },
  testes: { label: "/pruebas", hint: "Ejecuta la suite de pruebas (instala pytest si falta)" },
  perfil: { label: "/perfil", hint: "Abre el Perfil del proyecto (stack, rol, reglas)" },
  indice: { label: "/indice", hint: "Abre el Índice (skills + RAG que FORGE inyecta)" },
  projeto: { label: "/proyecto", hint: "Activa/desactiva el Modo Proyecto (blueprint aprobable)" },
  revisar: { label: "/revisar", hint: "Revisión multi-lente de los cambios del workspace (git diff)" },
  resumir: { label: "/resumir", hint: "Compacta el historial de la conversación en un resumen (libera la ventana)" },
  diagrama: { label: "/diagrama", hint: "Genera un diagrama Mermaid del codebase (propuesta en docs/diagramas/)" },
  sumario: { label: "/resumen proyecto", hint: "Documentación funcional del proyecto, estándar de mercado (propuesta en docs/SUMARIO_FUNCIONAL.md)" },
  impacto: { label: "/impacto", hint: "Radio de explosión del cambio (lineage del manifest dbt: downstream, pruebas, exposures)" },
  "traduzir-sql": { label: "/traducir-sql", hint: "Traduce el SQL del archivo activo a otro dialecto (propuesta .sql validada por el motor)" },
  "sql-lab": { label: "/sql-lab", hint: "Abre el laboratorio SQL local, persistente y gobernado con DuckDB embebido" },
  "importar-schema": { label: "/importar-esquema", hint: "Importa CREATE TABLE, claves e índices desde un archivo DDL al grounding local" },
  "validar-sql": { label: "/validar-sql", hint: "Valida seguridad, antipatrones, schema y compatibilidad del dialecto" },
  "plano-sql": { label: "/plan-sql", hint: "Cockpit estimado: EXPLAIN/dry-run, métricas y hotspots sin ejecutar la consulta" },
  "analisar-sql": { label: "/analizar-sql", hint: "Ejecuta el SELECT con consentimiento y mide tiempo, buffers y cardinalidad real" },
  "comparar-sql": { label: "/comparar-sql", hint: "Compara el plan del *.tuned.sql con el original sin ejecutar ambos" },
  "tunar-sql": { label: "/optimizar-sql", hint: "Genera una propuesta optimizada usando el plan real, dialecto y schema indexado" },
  conexoes: { label: "/conexiones", hint: "Lista y prueba las conexiones de warehouse (Oracle, PostgreSQL, BigQuery, DuckDB, S3/OCI)" },
  "executar-sql": { label: "/ejecutar-sql", hint: "Ejecuta el .sql activo en la conexión (SELECT directo; escritura confirma; DROP/TRUNCATE nunca)" },
  "schema-db": { label: "/schema-db", hint: "Indexa el schema REAL del warehouse (grounding: entra en el prompt y en el gate semántico)" },
  paridade: { label: "/paridad", hint: "Compara dos tablas por agregados (compliance-safe) — intra o entre warehouses" },
  custo: { label: "/costo", hint: "Costo: vista previa de la consulta activa (dry-run/EXPLAIN) o top consultas de los últimos 7 días" },
  "auditoria-pii": { label: "/auditoria-pii", hint: "Auditoría LGPD por nombre de columna en el schema indexado (dbt + warehouse) — 100% local" },
  "testes-dbt": { label: "/pruebas-dbt", hint: "Genera pruebas dbt (schema.yml) para un modelo, con las columnas REALES del manifest" },
  arquivos: { label: "/archivos", hint: "Lista los archivos del workspace (navegación gobernada — solo lectura)" },
  buscar: { label: "/buscar", hint: "Búsqueda por regex en los archivos del workspace (local, solo lectura; líneas enmascaradas)" },
  todos: { label: "/todos", hint: "Lista los TODO/FIXME/HACK/XXX del workspace (escaneo local determinístico)" },
  "git-status": { label: "/git-status", hint: "Estado del repositorio (branch, archivos modificados, adelante/atrás)" },
  "git-diff": { label: "/git-diff", hint: "Diferencias del working tree vs. el último commit (HEAD)" },
  "git-log": { label: "/git-log", hint: "Últimos commits (hash, autor, cuándo, asunto)" },
  "git-commit": { label: "/git-commit", hint: 'Hace commit de los archivos RASTREADOS modificados (confirmación obligatoria). Uso: /git-commit "mensaje"' },
};

// Overrides por locale (pt-BR = a fonte do array, sem entrada aqui). Adicionar um locale = adicionar
// uma entrada — commandLabel/commandHint/matchesFullForm não mudam (é a prova de escala do PR 11).
const COMMAND_OVERRIDES: Partial<Record<ReturnType<typeof getLocale>, Record<string, { label: string; hint: string }>>> = {
  en: COMMAND_EN,
  es: COMMAND_ES,
};

// Label/hint EXIBIDOS do comando, resolvidos pelo locale ativo (pt-BR = a fonte do array; resto = override).
export function commandLabel(cmd: SlashCommand): string {
  return COMMAND_OVERRIDES[getLocale()]?.[cmd.id]?.label ?? cmd.label;
}
export function commandHint(cmd: SlashCommand): string {
  return COMMAND_OVERRIDES[getLocale()]?.[cmd.id]?.hint ?? cmd.hint;
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

// A cauda digitada casa a FORMA COMPLETA do comando em QUALQUER locale (pt-BR do array OU um dos
// overrides)? Independe do locale ativo — um usuário pt que digita "/summary project" e um en que digita
// "/sumário projeto" ambos executam (a forma de uma palavra já é cross-locale via id/alias no matching).
export function matchesFullForm(cmd: SlashCommand, args: string): boolean {
  const norm = normalizeSlash(args.trim());
  const labels = [cmd.label, COMMAND_EN[cmd.id]?.label, COMMAND_ES[cmd.id]?.label].filter((l): l is string => !!l);
  return labels.some((l) => slashFullFormTail(l) === norm);
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

// Label EXIBIDO do /limpar no locale ativo, já como código markdown. Os cards o citam na prosa —
// referenciar o literal "/limpar" mostraria um comando pt-BR a um usuário en (o label é o que a paleta
// exibe; id/aliases garantem que as duas formas executam).
function clearCmdLabel(): string {
  const cmd = SLASH_COMMANDS.find((c) => c.id === "limpar");
  return `\`${cmd ? commandLabel(cmd) : "/limpar"}\``;
}

// Cartão do /resumir: confirma a compactação do histórico do HOST (a thread visível não muda).
export function renderSummarized(turns: number, summary: string): string {
  return `### ${t("sum.title")}\n\n${t("sum.body", { turns, clearCmd: clearCmdLabel() })}\n\n---\n\n${summary}`;
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
    r.attachments > 0 ? `| ${t("ctx.attachments", { count: r.attachments })} | ~${fmtK(r.attachmentTokens)} |` : "";
  return [
    `### ${t("ctx.title")} · ${r.modelId}`,
    "",
    `| | ${t("ctx.colTokens")} |`,
    `|---|---|`,
    `| ${t("ctx.window")} | ${fmtK(r.contextWindow)} |`,
    `| ${t("ctx.outputReserve")} | ${fmtK(r.outputReserve)} |`,
    `| ${t("ctx.inputBudget")} | ${fmtK(r.inputBudget)} |`,
    `| ${t("ctx.pinned")} | ~${fmtK(r.pinnedTokens)} |`,
    `| ${t("ctx.history", { count: r.historyTurns })} | ~${fmtK(r.historyTokens)} |`,
    ...(attach ? [attach] : []),
    "",
    `${t("ctx.estimate")} ${bar(estimated, r.inputBudget)}`,
    "",
    t("ctx.rag", { count: r.ragChunks }),
    t("ctx.session", { input: fmtK(r.sessionInputTokens), output: fmtK(r.sessionOutputTokens) }),
    // FinOps (#12): custo estimado da sessão (só com preços) + teto de gasto local, se configurado.
    ...(r.sessionCost !== undefined ? [t("ctx.cost", { cost: fmtCost(r.sessionCost), currency: r.currency ?? "" })] : []),
    ...(r.spendBudget
      ? [
          t("ctx.budget", {
            spent: fmtCost(r.sessionCost ?? 0),
            budget: fmtCost(r.spendBudget),
            currency: r.currency ?? "",
            pct: Math.round(((r.sessionCost ?? 0) / r.spendBudget) * 100),
          }),
          bar(r.sessionCost ?? 0, r.spendBudget),
        ]
      : []),
    "",
    `_${t("ctx.footnote", { clearCmd: clearCmdLabel() })}_`,
  ].join("\n");
}

// Formata custo (moeda) — fração para valores <1, 2 casas acima. Espelha o Controller.fmtCost do host.
function fmtCost(n: number): string {
  return n >= 1 ? n.toFixed(2) : n.toFixed(4);
}

// Cartão markdown do /tokens — dados locais da webview (usage do stream/end + acumulado da sessão).
export function renderTokensReport(u: { lastIn: number; lastOut: number; sessionIn: number; sessionOut: number } | null): string {
  if (!u || (u.sessionIn === 0 && u.sessionOut === 0)) {
    return `### ${t("tok.title")}\n\n${t("tok.empty")}`;
  }
  return [
    `### ${t("tok.title")}`,
    "",
    `| | ${t("tok.colIn")} | ${t("tok.colOut")} |`,
    "|---|---|---|",
    `| ${t("tok.last")} | ${fmtK(u.lastIn)} | ${fmtK(u.lastOut)} |`,
    `| ${t("tok.session")} | ${fmtK(u.sessionIn)} | ${fmtK(u.sessionOut)} |`,
    "",
    `_${t("tok.footnote")}_`,
  ].join("\n");
}

// Cartão markdown do /ajuda.
export function renderHelp(registry: SlashCommand[] = SLASH_COMMANDS): string {
  const rows = registry.map((c) => `| \`${commandLabel(c)}\` | ${commandHint(c)} |`);
  return [`### ${t("help.title")}`, "", `| ${t("help.colCommand")} | ${t("help.colWhat")} |`, "|---|---|", ...rows, "", `_${t("help.footer")}_`].join("\n");
}
