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

test("suíte de testes é SINGLETON: rodar várias vezes não empilha cartões (corrige acúmulo)", () => {
  let s: UIState = initialState;
  // simula o print: 3 execuções de teste seguidas (exit 5, 3, 0)
  for (const exitCode of [5, 3, 0]) {
    s = apply(s, {
      type: "run/result",
      filePath: "",
      label: "testes",
      command: "pytest -q",
      ok: exitCode === 0,
      exitCode,
      output: `exit ${exitCode}`,
      durationMs: 10,
    });
  }
  const testCards = s.runs.filter((r) => r.label === "testes");
  assert.equal(testCards.length, 1); // um único cartão, não três botões "Corrigir com FORGE"
  assert.equal(testCards[0].exitCode, 0); // reflete a ÚLTIMA execução
  assert.equal(testCards[0].ok, true);
  const idAfter = testCards[0].id;
  // re-rodar mantém o mesmo id (key estável no React)
  s = apply(s, { type: "run/result", filePath: "", label: "testes", command: "pytest -q", ok: false, exitCode: 1, output: "exit 1", durationMs: 9 });
  const after = s.runs.filter((r) => r.label === "testes");
  assert.equal(after.length, 1);
  assert.equal(after[0].id, idAfter);
  assert.equal(after[0].exitCode, 1);
});

test("cap: a lista de execuções não cresce sem limite e nunca descarta um cartão ao vivo", () => {
  let s: UIState = initialState;
  // um cartão ao vivo (running) criado primeiro
  s = apply(s, { type: "run/start", runId: "live", filePath: "live.py", command: "c", where: "panel" });
  // muitas execuções soltas finalizadas depois, que empurrariam o "live" para fora da janela
  for (let i = 0; i < 14; i++) {
    s = apply(s, { type: "run/result", runId: `r${i}`, filePath: `f${i}.py`, command: "c", ok: true, exitCode: 0, output: "", durationMs: 1 });
  }
  assert.equal(s.runs.length, 9); // aritmética exata: 8 do tail + 1 running preservado fora da janela
  const live = s.runs.find((r) => r.runId === "live");
  assert.ok(live, "o cartão ao vivo (running) deve ser preservado pelo cap");
  assert.equal(live?.running, true);
});

test("singleton só vale para 'testes': runs de arquivo distintos NÃO são fundidos", () => {
  let s: UIState = initialState;
  // duas execuções de arquivos diferentes, soltas (sem proposalId/runId, label != testes)
  s = apply(s, { type: "run/result", filePath: "a.py", command: "python a.py", ok: true, exitCode: 0, output: "", durationMs: 1 });
  s = apply(s, { type: "run/result", filePath: "b.py", command: "python b.py", ok: false, exitCode: 1, output: "", durationMs: 1 });
  assert.equal(s.runs.length, 2); // não coalesce — cada arquivo tem seu cartão
  // e o singleton de testes convive sem afetar os de arquivo
  s = apply(s, { type: "run/result", filePath: "", label: "testes", command: "pytest", ok: true, exitCode: 0, output: "", durationMs: 1 });
  assert.equal(s.runs.filter((r) => r.label === "testes").length, 1);
  assert.equal(s.runs.length, 3);
});
