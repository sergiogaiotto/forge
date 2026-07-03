// Paleta "/" do FORGE: registry declarativo dos comandos do composer + matching e renderizações
// PURAS (testáveis pelo host via tsx, como markdown.ts/state.ts). A EXECUÇÃO (post/dispatch) fica no
// DevPanel — aqui não entra React nem VS Code. Matching normaliza acentos: /sumário ≡ /sumario.
import type { ContextReport } from "../../src/shared/protocol";

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
  { id: "contexto", label: "/contexto", hint: "Orçamento da janela de contexto (modelo, reservas, histórico, RAG)", icon: "database" },
  { id: "tokens", label: "/tokens", hint: "Uso de tokens da sessão (última geração + acumulado)", icon: "activity" },
  { id: "limpar", label: "/limpar", hint: "Limpa a conversa DE VERDADE (histórico e anexos do host)", icon: "history", aliases: ["clear"] },
  { id: "ambiente", label: "/ambiente", hint: "Prepara o ambiente Python (venv + dependências)", icon: "plug", aliases: ["env"] },
  { id: "testes", label: "/testes", hint: "Roda a suíte de testes (instala o pytest se faltar)", icon: "terminal", aliases: ["test", "tests"] },
  { id: "perfil", label: "/perfil", hint: "Abre o Perfil do projeto (stack, papel, regras)", icon: "users" },
  { id: "indice", label: "/indice", hint: "Abre o Índice (skills + RAG que o FORGE injeta)", icon: "database", aliases: ["index"] },
  { id: "projeto", label: "/projeto", hint: "Liga/desliga o Modo Projeto (blueprint aprovável)", icon: "list-check" },
  { id: "revisar", label: "/revisar", hint: "Revisão multi-lente das alterações do workspace (git diff)", icon: "git-compare", aliases: ["review"] },
  { id: "resumir", label: "/resumir", hint: "Compacta o histórico da conversa num resumo (libera a janela)", icon: "copy", aliases: ["compactar"] },
  { id: "diagrama", label: "/diagrama", hint: "Gera diagrama Mermaid da codebase (proposta em docs/diagramas/)", icon: "network", aliases: ["diagram", "mermaid"], acceptsArgs: true },
];

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
  const rows = registry.map((c) => `| \`${c.label}\` | ${c.hint} |`);
  return ["### Paleta de comandos", "", "| comando | o que faz |", "|---|---|", ...rows, "", "_Digite `/` no chat para autocompletar._"].join("\n");
}
