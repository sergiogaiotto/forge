import assert from "node:assert/strict";
import { test } from "node:test";
import type { DiffProposal, ExtToWebview } from "../shared/protocol";
import { initialState, reducer, type UIState } from "../../webview-ui/src/state";

// Aplica uma sequência de mensagens do host (ExtToWebview) ao reducer da webview.
function apply(state: UIState, ...msgs: ExtToWebview[]): UIState {
  return msgs.reduce((s, msg) => reducer(s, { kind: "ext", msg }), state);
}

const PROPOSAL: DiffProposal = {
  id: "p1",
  filePath: "churn.py",
  language: "python",
  original: "",
  modified: "x = 1",
  summary: "novo",
  activatedSkills: [],
};

// Estado com uma proposta (via stream/start + stream/proposal), como na geração real.
function stateWithProposal(): UIState {
  return apply(
    initialState,
    { type: "stream/start", taskId: "t1" },
    { type: "stream/proposal", taskId: "t1", proposal: PROPOSAL },
    { type: "stream/end", taskId: "t1" }
  );
}

function proposalRun(state: UIState) {
  return state.messages.flatMap((m) => m.proposals).find((p) => p.proposal.id === "p1")?.run;
}

test("run/start marca o cartão da proposta como running (botão trava) e guarda o `where`", () => {
  const s = apply(stateWithProposal(), {
    type: "run/start",
    runId: "r1",
    proposalId: "p1",
    filePath: "churn.py",
    command: "python churn.py",
    where: "terminal",
  });
  const run = proposalRun(s);
  assert.equal(run?.running, true);
  assert.equal(run?.where, "terminal");
  assert.equal(run?.runId, "r1");
});

test("run/output concatena a saída ao vivo no cartão certo (por runId)", () => {
  let s = apply(stateWithProposal(), { type: "run/start", runId: "r1", proposalId: "p1", filePath: "churn.py", command: "c", where: "panel" });
  s = apply(s, { type: "run/output", runId: "r1", delta: "linha 1\n" }, { type: "run/output", runId: "r1", delta: "linha 2" });
  assert.equal(proposalRun(s)?.output, "linha 1\nlinha 2");
});

test("run/result finaliza o cartão ao vivo no lugar (running=false, exit code)", () => {
  let s = apply(stateWithProposal(), { type: "run/start", runId: "r1", proposalId: "p1", filePath: "churn.py", command: "c", where: "terminal" });
  s = apply(s, { type: "run/output", runId: "r1", delta: "parcial" });
  s = apply(s, {
    type: "run/result",
    runId: "r1",
    proposalId: "p1",
    filePath: "churn.py",
    command: "c",
    ok: true,
    exitCode: 0,
    output: "saída final",
    durationMs: 42,
  });
  const run = proposalRun(s);
  assert.equal(run?.running, false);
  assert.equal(run?.ok, true);
  assert.equal(run?.output, "saída final");
  assert.equal(run?.where, "terminal"); // preservado do run/start
  // não duplicou: continua um único cartão na proposta
  assert.equal(proposalRun(s) !== undefined, true);
});

test("run sem proposalId vai para a lista solta (runs) e finaliza no lugar", () => {
  let s = apply(initialState, { type: "run/start", runId: "r9", filePath: "x.py", command: "c", where: "panel" });
  assert.equal(s.runs.length, 1);
  assert.equal(s.runs[0].running, true);
  s = apply(s, { type: "run/result", runId: "r9", filePath: "x.py", command: "c", ok: false, exitCode: 1, output: "boom", durationMs: 5 });
  assert.equal(s.runs.length, 1); // mesmo cartão, não um novo
  assert.equal(s.runs[0].running, false);
  assert.equal(s.runs[0].ok, false);
  assert.equal(s.runs[0].exitCode, 1);
});

test("run/result sem run/start prévio (ex.: skipped) ainda cria o cartão", () => {
  const s = apply(stateWithProposal(), {
    type: "run/result",
    runId: "rx",
    proposalId: "p1",
    filePath: "churn.py",
    command: "",
    ok: false,
    exitCode: null,
    output: "",
    durationMs: 0,
    skippedReason: "Tipo sem comando",
  });
  assert.equal(proposalRun(s)?.skippedReason, "Tipo sem comando");
  assert.equal(proposalRun(s)?.running, false);
});

test("run de teste (label=testes) atualiza lastTestRun, não lastFileRun", () => {
  const s = apply(initialState, {
    type: "run/result",
    filePath: "",
    label: "testes",
    command: "pytest",
    ok: true,
    exitCode: 0,
    output: "5 passed",
    durationMs: 100,
  });
  assert.equal(s.lastTestRun?.ok, true);
  assert.equal(s.lastFileRun, null);
});
