import type {
  CharterKey,
  CharterSections,
  DiffProposal,
  ExtToWebview,
  ForgeState,
  ProfileView,
  ProjectArchitecture,
  ProjectBlueprintView,
  ProjectFramework,
  ProjectGateFileView,
  ProjectLanguage,
  ProjectUI,
  RagChunkView,
  RagInspectView,
  RoleCard,
  SkillInspectView,
  ValidatorResult,
  WorkspaceEntry,
} from "../../src/shared/protocol";

// Pedido de projeto em curso (o brief), retido para o "Tentar de novo" após uma falha do blueprint.
// `ui` viaja junto para o retry reenviar a mesma escolha de camada de UI.
export type ProjectBrief = { text: string; language: ProjectLanguage; architecture: ProjectArchitecture; ui?: ProjectUI; framework?: ProjectFramework };
// Resultado do gate workspace-wide (compileall/mypy sobre o conjunto gerado). advisory = não pôde rodar.
export type ProjectGateState = { advisory: boolean; partial: boolean; requiresContractConfirm?: boolean; summary: string; files: ProjectGateFileView[]; projectErrors: string[]; dod: string[]; security: string[] };
import { CHARTER_KEYS } from "../../src/shared/protocol";
import { renderContextReport, renderSummarized } from "./commands";
export type { ProfileView } from "../../src/shared/protocol";

// Re-exporta os parsers de bloco (compartilhados com o host) para os componentes da webview.
export { parsePartialFileBlocks, stripFileBlocksFromText } from "../../src/util/fileBlocks";
export type { PartialFileBlock } from "../../src/util/fileBlocks";
import { stripFileBlockOfPath } from "../../src/util/fileBlocks";

export interface RunResultData {
  runId?: string;
  filePath: string;
  label?: string;
  command: string;
  ok: boolean;
  exitCode: number | null;
  output: string;
  durationMs: number;
  skippedReason?: string;
  running?: boolean; // true entre run/start e run/result (cartão ao vivo + botão travado)
  where?: "terminal" | "panel"; // onde a execução acontece (mostra "Ver no terminal" só no terminal)
}

export interface ProposalVM {
  proposal: DiffProposal;
  validation?: { running: boolean; results: ValidatorResult[]; gateOk: boolean };
  status: "pending" | "applied" | "discarded";
  run?: RunResultData;
}

export interface MessageVM {
  id: string;
  role: "user" | "assistant";
  text: string;
  reasoning: string;
  skills: string[];
  proposals: ProposalVM[];
  streaming: boolean;
  error?: string;
  warning?: string; // aviso não-fatal ancorado (ex.: truncamento por limite de tokens)
}

export interface Toast {
  level: "info" | "warn" | "error";
  message: string;
  seq: number;
}

export interface ApprovalRequest {
  requestId: string;
  server: string;
  tool: string;
  scope: string;
  argsPreview: string;
}

export interface UIState {
  forge: ForgeState | null;
  messages: MessageVM[];
  runs: (RunResultData & { id: string })[];
  busy: boolean;
  toast: Toast | null;
  approval: ApprovalRequest | null;
  providerTest: { ok: boolean; message: string; latencyMs?: number; pending: boolean } | null;
  embeddingsTest: { ok: boolean; mode: "embeddings" | "lexical"; message: string; dims?: number; latencyMs?: number; pending: boolean } | null;
  reviewed: boolean;
  lastFileRun: RunResultData | null;
  lastTestRun: RunResultData | null;
  attachments: { id: string; label: string; bytes: number; kind: "workspace" | "upload" | "selection" | "search" }[];
  workspaceFiles: WorkspaceEntry[]; // catálogo do workspace para a menção "@" (cacheado; carregado sob demanda)
  profile: ProfileView | null;
  // notes: aviso/erro ancorado POR SEÇÃO, renderizado dentro do modal do wizard — um toast ficaria
  // atrás do backdrop (z-index) e sumiria em 5s sem ser visto (ex.: seção truncada por limite de tokens).
  charter: { sections: CharterSections; drafting: Record<CharterKey, boolean>; notes: CharterNotes } | null;
  // Fase F: blueprint do Modo Projeto + fase (planejando/gerando). Null = sem fluxo de projeto ativo.
  // planStep: etapa atual do planejamento (narração), mostrada enquanto o blueprint não chegou.
  // error: falha do blueprint — o modal FICA ABERTO mostrando o erro + "Tentar de novo" (não some).
  // warning: aviso não-fatal DENTRO do modal (ex.: plano parcial recuperado após truncamento).
  // brief: o pedido em curso, para o retry reenviar sem redigitar.
  // gate: resultado do gate workspace-wide (compileall/mypy) — pinta os cartões reprovados e resume.
  project: { blueprint: ProjectBlueprintView | null; busy: boolean; done: boolean; planStep?: string; error?: string; warning?: string; brief?: ProjectBrief; gate?: ProjectGateState } | null;
  // Seq monotônico incrementado a cada "project/appliedAll" (aplicou todos os arquivos). O DevPanel
  // observa a mudança para desmarcar o Modo Projeto automaticamente (0 = nunca ocorreu).
  appliedAllAt: number;
  // Usage REAL de tokens (stream/end): última geração + acumulado da sessão — /tokens e barra de status.
  usage: { lastIn: number; lastOut: number; sessionIn: number; sessionOut: number } | null;
  // Cartão pós-seleção do papel (o que o papel carrega) — dispensável pelo dev.
  roleCard: RoleCard | null;
  inspect: {
    skills: SkillInspectView[];
    rag: RagInspectView | null;
    skillBody: Record<string, string>; // name → corpo do SKILL.md (cache sob demanda)
    ragFile: Record<string, RagChunkView[]>; // relPath → chunks (cache sob demanda)
  } | null;
}

export type CharterNotes = Partial<Record<CharterKey, { level: "warn" | "error"; message: string }>>;

const emptyInspect = (): NonNullable<UIState["inspect"]> => ({ skills: [], rag: null, skillBody: {}, ragFile: {} });

const noDrafting = (): Record<CharterKey, boolean> =>
  CHARTER_KEYS.reduce((a, k) => ({ ...a, [k]: false }), {} as Record<CharterKey, boolean>);

export const initialState: UIState = {
  forge: null,
  messages: [],
  runs: [],
  busy: false,
  toast: null,
  approval: null,
  providerTest: null,
  embeddingsTest: null,
  reviewed: false,
  lastFileRun: null,
  lastTestRun: null,
  attachments: [],
  workspaceFiles: [],
  profile: null,
  charter: null,
  project: null,
  appliedAllAt: 0,
  usage: null,
  roleCard: null,
  inspect: null,
};

export type Action =
  | { kind: "ext"; msg: ExtToWebview }
  | { kind: "pushUser"; text: string }
  | { kind: "pushLocal"; text: string }
  | { kind: "roleCard/dismiss" }
  | { kind: "providerTestPending" }
  | { kind: "embeddingsTestPending" }
  | { kind: "newConversation" }
  | { kind: "clearApproval" }
  | { kind: "clearProfile" }
  | { kind: "run/dismiss"; id: string }
  | { kind: "charter/edit"; section: CharterKey; text: string }
  | { kind: "project/planning"; brief: ProjectBrief }
  | { kind: "project/generating" }
  | { kind: "project/close" }
  | { kind: "clearToast" };

let toastSeq = 0;
let runSeq = 0;
let appliedAllSeq = 0;
const RUN_OUTPUT_CAP = 20_000; // tail de saída ao vivo guardada no estado (evita estado gigante)
const RUN_CARDS_CAP = 8; // teto de cartões de execução retidos (rede de segurança contra acúmulo)

// A suíte de testes é um SINGLETON: um único cartão "testes" substituído a cada execução, em vez de
// empilhar um novo a cada rodada (o que multiplicava os botões "Corrigir com FORGE" — exit 5/3/3...).
// Demais execuções: append normal. Preserva o `id` do cartão substituído (key estável no React).
// Cobre o caminho atual (run/result de testes sem runId, vindo de Controller.runTests). Se um dia os
// testes ganharem ciclo ao vivo (run/start com runId), o singleton precisa ser estendido ao run/start.
function upsertRun(
  runs: (RunResultData & { id: string })[],
  incoming: RunResultData & { id: string }
): (RunResultData & { id: string })[] {
  if (incoming.label === "testes") {
    const idx = runs.findIndex((r) => r.label === "testes");
    if (idx >= 0) {
      const next = runs.slice();
      next[idx] = { ...incoming, id: runs[idx].id };
      return next;
    }
  }
  return [...runs, incoming];
}

// Rede de segurança contra crescimento ilimitado em sessões longas: mantém os últimos N cartões,
// mas nunca descarta um cartão ao vivo (running) que ficaria fora da janela.
function capRuns(runs: (RunResultData & { id: string })[]): (RunResultData & { id: string })[] {
  if (runs.length <= RUN_CARDS_CAP) return runs;
  const tail = runs.slice(-RUN_CARDS_CAP);
  const keptRunning = runs.slice(0, -RUN_CARDS_CAP).filter((r) => r.running);
  return [...keptRunning, ...tail];
}

function lastAssistant(messages: MessageVM[]): MessageVM | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") return messages[i];
  }
  return undefined;
}

export function reducer(state: UIState, action: Action): UIState {
  switch (action.kind) {
    case "clearToast":
      return { ...state, toast: null };
    case "clearApproval":
      return { ...state, approval: null };
    case "clearProfile":
      return { ...state, profile: null };
    case "run/dismiss":
      // Oculta um cartão de execução/teste solto da thread (remove pelo id estável do cartão).
      return { ...state, runs: state.runs.filter((r) => r.id !== action.id) };
    case "charter/edit":
      // Edição local de uma seção do charter (textarea controlado pelo estado global). Editar a seção
      // dá baixa no aviso/erro dela (o dev viu e está corrigindo — o aviso ficaria stale).
      if (!state.charter) return state;
      return {
        ...state,
        charter: {
          ...state.charter,
          sections: { ...state.charter.sections, [action.section]: action.text },
          notes: { ...state.charter.notes, [action.section]: undefined },
        },
      };
    case "project/planning":
      return { ...state, project: { blueprint: null, busy: true, done: false, brief: action.brief } };
    case "project/generating":
      // Aprovou e começou a gerar → o aviso de "revise antes de aprovar" já cumpriu o papel. Limpa o
      // gate anterior (a regeração produz um veredito novo) para não pintar cartões com erro obsoleto.
      return { ...state, project: { ...(state.project ?? { blueprint: null, done: false }), busy: true, done: false, error: undefined, warning: undefined, gate: undefined } };
    case "project/close":
      return { ...state, project: null };
    case "newConversation":
      return { ...state, messages: [], runs: [], busy: false, reviewed: false, lastFileRun: null, lastTestRun: null };
    case "providerTestPending":
      return { ...state, providerTest: { ok: false, message: "", pending: true } };
    case "embeddingsTestPending":
      return { ...state, embeddingsTest: { ok: false, mode: "lexical", message: "", pending: true } };
    case "pushUser":
      return {
        ...state,
        messages: [
          ...state.messages,
          { id: `u_${Date.now()}`, role: "user", text: action.text, reasoning: "", skills: [], proposals: [], streaming: false },
        ],
      };
    case "pushLocal":
      // Mensagem LOCAL do assistente (cartões da paleta: /ajuda, /tokens) — nunca vai ao host.
      return pushLocalMessage(state, action.text);
    case "roleCard/dismiss":
      return { ...state, roleCard: null };
    case "ext":
      return applyExt(state, action.msg);
    default:
      return state;
  }
}

function applyExt(state: UIState, msg: ExtToWebview): UIState {
  switch (msg.type) {
    case "state":
      return { ...state, forge: msg.state };
    case "notice":
      return { ...state, toast: { level: msg.level, message: msg.message, seq: ++toastSeq } };
    case "providerTestResult":
      return { ...state, providerTest: { ok: msg.ok, message: msg.message, latencyMs: msg.latencyMs, pending: false } };
    case "embeddingsTestResult":
      return {
        ...state,
        embeddingsTest: { ok: msg.ok, mode: msg.mode, message: msg.message, dims: msg.dims, latencyMs: msg.latencyMs, pending: false },
      };
    case "mcp/approvalRequest":
      return {
        ...state,
        approval: { requestId: msg.requestId, server: msg.server, tool: msg.tool, scope: msg.scope, argsPreview: msg.argsPreview },
      };
    case "stream/start":
      return {
        ...state,
        busy: true,
        messages: [
          ...state.messages,
          { id: msg.taskId, role: "assistant", text: "", reasoning: "", skills: [], proposals: [], streaming: true },
        ],
      };
    case "stream/skill":
      return updateLastAssistant(state, (m) => (m.skills.includes(msg.skill) ? m : { ...m, skills: [...m.skills, msg.skill] }));
    case "stream/reasoning":
      return updateLastAssistant(state, (m) => ({ ...m, reasoning: m.reasoning + msg.delta }));
    case "stream/text":
      return updateLastAssistant(state, (m) => ({ ...m, text: m.text + msg.delta }));
    case "stream/proposal":
      return updateLastAssistant(state, (m) => ({
        ...m,
        text: stripFileBlockOfPath(m.text, msg.proposal.filePath),
        proposals: [...m.proposals, { proposal: msg.proposal, status: "pending" }],
      }));
    case "stream/proposalUpdate":
      // Onda 2: o auto-reparo regenerou este arquivo — troca a proposta NO LUGAR (mesmo id), volta a
      // "pending" e limpa a validação anterior (o gate/validador a revisita).
      return mapProposals(state, msg.proposal.id, (p) => ({ ...p, proposal: msg.proposal, status: "pending", validation: undefined }));
    case "validation/result":
      return mapProposals(state, msg.proposalId, (p) => ({
        ...p,
        validation: { running: msg.running, results: msg.results, gateOk: msg.gateOk },
      }));
    case "proposal/applied":
      // nova alteração aplicada invalida a revisão anterior (precisa revisar de novo)
      return { ...mapProposals(state, msg.proposalId, (p) => ({ ...p, status: "applied" })), reviewed: false };
    case "review/done":
      return { ...state, reviewed: true };
    case "context/attachments":
      return { ...state, attachments: msg.items };
    case "context/workspaceFiles":
      return { ...state, workspaceFiles: msg.items };
    case "profile/state":
      return { ...state, profile: msg.profile };
    case "project/blueprint":
      // Blueprint chegou → limpa qualquer erro/gate anterior, preserva o brief (para retry futuro).
      // warning (ex.: plano parcial após truncamento) renderiza DENTRO do modal, acima da lista.
      return { ...state, project: { ...state.project, blueprint: msg.blueprint, busy: false, done: false, error: undefined, warning: msg.warning, gate: undefined } };
    case "project/blueprintError":
      // NÃO fecha o modal: mantém aberto com o erro real + "Tentar de novo" (o brief está retido).
      // Fallback ao toast só se, por acaso, não houver modal (state.project null).
      return state.project
        ? { ...state, project: { ...state.project, busy: false, error: msg.message } }
        : { ...state, toast: { level: "error", message: msg.message, seq: ++toastSeq } };
    case "project/status":
      return state.project?.blueprint
        ? { ...state, project: { ...state.project, blueprint: { ...state.project.blueprint, files: msg.files } } }
        : state;
    case "project/fileStatus":
      // Patch pontual de UM arquivo (progresso um-a-um) — não reconstrói o array a partir do host.
      return state.project?.blueprint
        ? {
            ...state,
            project: {
              ...state.project,
              blueprint: {
                ...state.project.blueprint,
                files: state.project.blueprint.files.map((f) => (f.path === msg.path ? { ...f, status: msg.status } : f)),
              },
            },
          }
        : state;
    case "project/planStep":
      // Narração do planejamento (só relevante enquanto o blueprint não chegou).
      return state.project ? { ...state, project: { ...state.project, planStep: msg.label } } : state;
    case "project/gate":
      // Gate workspace-wide: guarda o veredito para pintar os cartões reprovados e o resumo no modal.
      return state.project ? { ...state, project: { ...state.project, gate: { advisory: msg.advisory, partial: msg.partial, requiresContractConfirm: msg.requiresContractConfirm, summary: msg.summary, files: msg.files, projectErrors: msg.projectErrors, dod: msg.dod, security: msg.security } } } : state;
    case "project/done":
      return state.project ? { ...state, project: { ...state.project, busy: false, done: true } } : state;
    case "project/appliedAll":
      // Aplicou tudo → sinaliza o DevPanel (via seq) para desmarcar o Modo Projeto. O modal segue
      // aberto mostrando os status "aplicado"; o dev fecha quando quiser.
      return { ...state, appliedAllAt: ++appliedAllSeq };
    case "project/closed":
      // Fecha o modal do projeto sem erro (redirecionado ao chat pela defesa em profundidade do host).
      return { ...state, project: null };
    case "charter/state":
      return { ...state, charter: { sections: msg.sections, drafting: noDrafting(), notes: {} } };
    case "charter/drafting":
      // Novo rascunho em curso → limpa o aviso/erro anterior da seção (vai ser reavaliado ao chegar).
      return state.charter
        ? {
            ...state,
            charter: {
              ...state.charter,
              drafting: { ...state.charter.drafting, [msg.section]: true },
              notes: { ...state.charter.notes, [msg.section]: undefined },
            },
          }
        : state;
    case "charter/drafted": {
      if (!state.charter) return state;
      // Defesa em profundidade: um drafted VAZIO nunca sobrescreve o texto do dev. O Controller já
      // converte resposta vazia em charter/error; se esse guard regredir, o reducer segura a perda
      // (o textarea é estado controlado — sobrescrever com "" destruiria o rascunho sem volta).
      const empty = !msg.text.trim();
      return {
        ...state,
        charter: {
          sections: empty ? state.charter.sections : { ...state.charter.sections, [msg.section]: msg.text },
          drafting: { ...state.charter.drafting, [msg.section]: false },
          notes: {
            ...state.charter.notes,
            [msg.section]: empty
              ? { level: "error" as const, message: "O modelo não retornou conteúdo para a seção. Tente de novo." }
              : msg.warning
                ? { level: "warn" as const, message: msg.warning }
                : undefined,
          },
        },
      };
    }
    case "charter/error":
      // Com o wizard aberto o erro ancora NA SEÇÃO (o toast renderiza atrás do backdrop do modal e
      // some em 5s). Toast só como fallback quando não há wizard (não deveria ocorrer).
      return state.charter
        ? {
            ...state,
            charter: {
              ...state.charter,
              drafting: { ...state.charter.drafting, [msg.section]: false },
              notes: { ...state.charter.notes, [msg.section]: { level: "error" as const, message: msg.message } },
            },
          }
        : { ...state, toast: { level: "error", message: msg.message, seq: ++toastSeq } };
    case "skills/inspect":
      // Reabrir o Índice re-emite a lista → zera o cache de corpos (evita SKILL.md stale após editar/reindexar).
      return { ...state, inspect: { ...(state.inspect ?? emptyInspect()), skills: msg.skills, skillBody: {} } };
    case "skills/body":
      return { ...state, inspect: { ...(state.inspect ?? emptyInspect()), skillBody: { ...(state.inspect?.skillBody ?? {}), [msg.name]: msg.body } } };
    case "rag/inspect":
      // idem para os chunks (o índice pode ter sido reconstruído).
      return { ...state, inspect: { ...(state.inspect ?? emptyInspect()), rag: msg.index, ragFile: {} } };
    case "rag/file":
      return { ...state, inspect: { ...(state.inspect ?? emptyInspect()), ragFile: { ...(state.inspect?.ragFile ?? {}), [msg.relPath]: msg.chunks } } };
    case "proposal/discarded":
      return mapProposals(state, msg.proposalId, (p) => ({ ...p, status: "discarded" }));
    case "run/start": {
      const live: RunResultData = {
        runId: msg.runId,
        filePath: msg.filePath,
        label: msg.label,
        command: msg.command,
        ok: false,
        exitCode: null,
        output: "",
        durationMs: 0,
        running: true,
        where: msg.where,
      };
      if (msg.proposalId) return mapProposals(state, msg.proposalId, (p) => ({ ...p, run: live }));
      return { ...state, runs: capRuns([...state.runs, { ...live, id: msg.runId }]) };
    }
    case "run/output":
      return updateRunByRunId(state, msg.runId, (r) => ({ ...r, output: (r.output + msg.delta).slice(-RUN_OUTPUT_CAP) }));
    case "run/result": {
      const data: RunResultData = {
        runId: msg.runId,
        filePath: msg.filePath,
        label: msg.label,
        command: msg.command,
        ok: msg.ok,
        exitCode: msg.exitCode,
        output: msg.output,
        durationMs: msg.durationMs,
        skippedReason: msg.skippedReason,
        running: false,
      };
      // Só execução de ARQUIVO (label indefinido) alimenta lastFileRun (o chip "Executa" da DoD);
      // "testes" vai para lastTestRun; "ambiente"/"célula [i]" e afins são neutros (não poluem a DoD).
      const last = data.label === "testes" ? { lastTestRun: data } : data.label ? {} : { lastFileRun: data };
      // Se já existe um cartão ao vivo (criado pelo run/start), finaliza-o no lugar (preserva `where`).
      if (msg.runId && hasRunWithId(state, msg.runId)) {
        return { ...updateRunByRunId(state, msg.runId, (r) => ({ ...data, where: r.where })), ...last };
      }
      if (msg.proposalId) return { ...mapProposals(state, msg.proposalId, (p) => ({ ...p, run: data })), ...last };
      // Fallback de id com prefixo LOCAL: o host usa `run_${seq}` para runId; um prefixo distinto
      // evita colidir a key do React entre um cartão de teste (sem runId) e um de arquivo (com runId).
      return { ...state, runs: capRuns(upsertRun(state.runs, { ...data, id: msg.runId ?? `local_run_${++runSeq}` })), ...last };
    }
    case "stream/end": {
      // usage REAL da geração (somado entre continuações) → /tokens e o medidor da barra de status.
      const usage = msg.usage
        ? {
            lastIn: msg.usage.inputTokens,
            lastOut: msg.usage.outputTokens,
            sessionIn: (state.usage?.sessionIn ?? 0) + msg.usage.inputTokens,
            sessionOut: (state.usage?.sessionOut ?? 0) + msg.usage.outputTokens,
          }
        : state.usage;
      return { ...state, busy: false, usage, messages: state.messages.map((m) => (m.id === msg.taskId ? { ...m, streaming: false } : m)) };
    }
    case "context/report":
      // /contexto: o relatório vira uma mensagem local do assistente (markdown), na própria thread.
      return pushLocalMessage(state, renderContextReport(msg.report));
    case "impact/report":
      // /impacto: o raio de explosão (host-computado do manifest dbt) vira cartão na thread.
      return pushLocalMessage(state, msg.markdown);
    case "profile/roleCard":
      return { ...state, roleCard: msg.card };
    case "chat/summarized":
      // /resumir: o host compactou o histórico — o cartão mostra exatamente o que o modelo passa a ver.
      return pushLocalMessage(state, renderSummarized(msg.turns, msg.summary));
    case "stream/error": {
      // usage parcial da geração que morreu — os tokens foram consumidos; acumula como no stream/end.
      const usage = msg.usage
        ? {
            lastIn: msg.usage.inputTokens,
            lastOut: msg.usage.outputTokens,
            sessionIn: (state.usage?.sessionIn ?? 0) + msg.usage.inputTokens,
            sessionOut: (state.usage?.sessionOut ?? 0) + msg.usage.outputTokens,
          }
        : state.usage;
      return {
        ...state,
        busy: false,
        usage,
        messages: state.messages.map((m) => (m.id === msg.taskId ? { ...m, streaming: false, error: msg.message } : m)),
      };
    }
    case "stream/notice":
      // Aviso não-fatal: anexa ao balão da resposta sem encerrar o streaming. Acumula se houver mais de um.
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === msg.taskId ? { ...m, warning: m.warning ? `${m.warning}\n${msg.message}` : msg.message } : m
        ),
      };
    default:
      return state;
  }
}

let localSeq = 0;
// Anexa uma mensagem local do assistente (cartões da paleta "/": /ajuda, /tokens, /contexto).
function pushLocalMessage(state: UIState, text: string): UIState {
  return {
    ...state,
    messages: [...state.messages, { id: `local_${++localSeq}`, role: "assistant", text, reasoning: "", skills: [], proposals: [], streaming: false }],
  };
}

function updateLastAssistant(state: UIState, fn: (m: MessageVM) => MessageVM): UIState {
  const target = lastAssistant(state.messages);
  if (!target) return state;
  return { ...state, messages: state.messages.map((m) => (m.id === target.id ? fn(m) : m)) };
}

function mapProposals(state: UIState, proposalId: string, fn: (p: ProposalVM) => ProposalVM): UIState {
  return {
    ...state,
    messages: state.messages.map((m) => ({
      ...m,
      proposals: m.proposals.map((p) => (p.proposal.id === proposalId ? fn(p) : p)),
    })),
  };
}

// Há algum cartão de execução (em uma proposta ou na lista solta) com este runId?
function hasRunWithId(state: UIState, runId: string): boolean {
  if (state.runs.some((r) => r.runId === runId)) return true;
  return state.messages.some((m) => m.proposals.some((p) => p.run?.runId === runId));
}

// Atualiza o cartão de execução com este runId onde quer que ele esteja (proposta ou lista solta).
function updateRunByRunId(state: UIState, runId: string, fn: (r: RunResultData) => RunResultData): UIState {
  return {
    ...state,
    messages: state.messages.map((m) => ({
      ...m,
      proposals: m.proposals.map((p) => (p.run && p.run.runId === runId ? { ...p, run: fn(p.run) } : p)),
    })),
    runs: state.runs.map((r) => (r.runId === runId ? { ...fn(r), id: r.id } : r)),
  };
}
