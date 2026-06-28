import type { DiffProposal, ExtToWebview, ForgeState, ValidatorResult } from "../../src/shared/protocol";

export interface RunResultData {
  filePath: string;
  label?: string;
  command: string;
  ok: boolean;
  exitCode: number | null;
  output: string;
  durationMs: number;
  skippedReason?: string;
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
};

export type Action =
  | { kind: "ext"; msg: ExtToWebview }
  | { kind: "pushUser"; text: string }
  | { kind: "providerTestPending" }
  | { kind: "embeddingsTestPending" }
  | { kind: "newConversation" }
  | { kind: "clearApproval" }
  | { kind: "clearToast" };

let toastSeq = 0;
let runSeq = 0;

// Remove o bloco ```forge-file path=...``` de um determinado caminho do texto transmitido
// para que o cartão de diff não seja duplicado pela cerca bruta.
function stripFileBlock(text: string, filePath: string): string {
  const escaped = filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("```forge-file\\s+path=[\"']?" + escaped + "[\"']?\\n[\\s\\S]*?```", "g");
  return text.replace(re, "").replace(/\n{3,}/g, "\n\n").trimEnd();
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
        text: stripFileBlock(m.text, msg.proposal.filePath),
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
    case "proposal/discarded":
      return mapProposals(state, msg.proposalId, (p) => ({ ...p, status: "discarded" }));
    case "run/result": {
      const data: RunResultData = {
        filePath: msg.filePath,
        label: msg.label,
        command: msg.command,
        ok: msg.ok,
        exitCode: msg.exitCode,
        output: msg.output,
        durationMs: msg.durationMs,
        skippedReason: msg.skippedReason,
      };
      const last = data.label === "testes" ? { lastTestRun: data } : { lastFileRun: data };
      if (msg.proposalId) return { ...mapProposals(state, msg.proposalId, (p) => ({ ...p, run: data })), ...last };
      return { ...state, runs: [...state.runs, { ...data, id: `run_${++runSeq}` }], ...last };
    }
    case "stream/end":
      return { ...state, busy: false, messages: state.messages.map((m) => (m.id === msg.taskId ? { ...m, streaming: false } : m)) };
    case "stream/error":
      return {
        ...state,
        busy: false,
        messages: state.messages.map((m) => (m.id === msg.taskId ? { ...m, streaming: false, error: msg.message } : m)),
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
