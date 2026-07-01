import type { DiffProposal, ExtToWebview, ForgeState, ProfileView, ValidatorResult } from "../../src/shared/protocol";
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
  profile: ProfileView | null;
}

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
  profile: null,
};

export type Action =
  | { kind: "ext"; msg: ExtToWebview }
  | { kind: "pushUser"; text: string }
  | { kind: "providerTestPending" }
  | { kind: "embeddingsTestPending" }
  | { kind: "newConversation" }
  | { kind: "clearApproval" }
  | { kind: "clearProfile" }
  | { kind: "run/dismiss"; id: string }
  | { kind: "clearToast" };

let toastSeq = 0;
let runSeq = 0;
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
    case "profile/state":
      return { ...state, profile: msg.profile };
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
    case "stream/end":
      return { ...state, busy: false, messages: state.messages.map((m) => (m.id === msg.taskId ? { ...m, streaming: false } : m)) };
    case "stream/error":
      return {
        ...state,
        busy: false,
        messages: state.messages.map((m) => (m.id === msg.taskId ? { ...m, streaming: false, error: msg.message } : m)),
      };
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
