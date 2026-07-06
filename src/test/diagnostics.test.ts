import assert from "node:assert/strict";
import { test } from "node:test";
import { renderDiagnosticsBundle, toDiagnosticRecord } from "../obs/diagnostics";
import { ObsEvent } from "../obs/types";

const TS = "2026-07-05T12:00:00.000Z";

test("toDiagnosticRecord: generation.start carrega metadados e MASCARA o userId (masked)", () => {
  const e: ObsEvent = { type: "generation.start", taskId: "t1", mode: "project", model: "gpt-oss-120b", provider: "openai", skills: ["pandas"], sessionId: "s1", userId: "dev@claro.com.br", org: "claro" };
  const r = toDiagnosticRecord(e, TS, "masked");
  assert.equal(r.ts, TS);
  assert.equal(r.type, "generation.start");
  assert.equal(r.mode, "project");
  assert.equal(r.model, "gpt-oss-120b");
  assert.deepEqual(r.skills, ["pandas"]);
  // e-mail nunca sai cru em masked (vira hash u_...)
  assert.notEqual(r.userId, "dev@claro.com.br");
  assert.match(String(r.userId), /^u_[0-9a-f]{12}$/);
});

test("toDiagnosticRecord: generation.end MASCARA segredos no input/output", () => {
  const e: ObsEvent = {
    type: "generation.end",
    taskId: "t1",
    durationMs: 1200,
    model: "gpt-oss-120b",
    input: "use a chave sk-ant-abc123def456ghi789 no cliente",
    output: "meu email é foo@bar.com e o token Bearer xyz.abc.def",
    usage: { inputTokens: 10, outputTokens: 20 },
    proposals: 2,
  };
  const r = toDiagnosticRecord(e, TS, "masked");
  assert.equal(r.durationMs, 1200);
  assert.equal(r.proposals, 2);
  assert.doesNotMatch(String(r.input), /sk-ant-abc123def456ghi789/); // segredo redigido
  assert.match(String(r.input), /‹redacted›/);
  assert.doesNotMatch(String(r.output), /foo@bar\.com/); // PII redigida
});

test("toDiagnosticRecord: metadata-only OMITE o conteúdo (input/output undefined)", () => {
  const e: ObsEvent = { type: "generation.end", taskId: "t1", durationMs: 1, model: "m", input: "segredo", output: "saída", proposals: 0 };
  const r = toDiagnosticRecord(e, TS, "metadata-only");
  assert.equal(r.input, undefined);
  assert.equal(r.output, undefined);
  assert.equal(r.proposals, 0); // metadados seguem presentes
});

test("toDiagnosticRecord: eventos de workflow (validation/run/proposal) mapeiam campos", () => {
  const v = toDiagnosticRecord({ type: "validation.result", filePath: "src/a.py", gateOk: false, validators: [{ id: "ruff", status: "failed" }] }, TS, "masked");
  assert.equal(v.filePath, "src/a.py");
  assert.equal(v.gateOk, false);
  const run = toDiagnosticRecord({ type: "run.result", filePath: "src/a.py", label: "testes", ok: false, exitCode: 1, durationMs: 5 }, TS, "masked");
  assert.equal(run.ok, false);
  assert.equal(run.exitCode, 1);
  const p = toDiagnosticRecord({ type: "proposal.applied", filePath: "src/a.py" }, TS, "masked");
  assert.equal(p.type, "proposal.applied");
  assert.equal(p.filePath, "src/a.py");
});

test("renderDiagnosticsBundle: inclui manifesto, resumo acionável e os eventos NDJSON", () => {
  const records = [
    toDiagnosticRecord({ type: "generation.start", taskId: "t1", mode: "normal", model: "m", provider: "p", skills: [], sessionId: "s1", userId: "x" }, TS, "masked"),
    toDiagnosticRecord({ type: "generation.end", taskId: "t1", durationMs: 1, model: "m", input: "i", output: "o", proposals: 1, error: "estourou a janela (400)" }, TS, "masked"),
    toDiagnosticRecord({ type: "validation.result", filePath: "a.py", gateOk: false, validators: [] }, TS, "masked"),
    toDiagnosticRecord({ type: "proposal.applied", filePath: "a.py" }, TS, "masked"),
  ];
  const md = renderDiagnosticsBundle(records, { forgeVersion: "2.2.0", platform: "win32" });
  assert.match(md, /# FORGE — Bundle de diagnóstico/);
  assert.match(md, /"forgeVersion": "2\.2\.0"/); // manifesto
  assert.match(md, /Gerações: 1/);
  assert.match(md, /Erros de geração: 1/); // o generation.end com error entrou no resumo
  assert.match(md, /Reprovações de gate: 1/); // o validation.result gateOk:false entrou
  assert.match(md, /aplicadas: 1/);
  assert.match(md, /"type":"generation.start"/); // eventos brutos em NDJSON
  // o erro da geração aparece no dump (útil para o suporte)
  assert.match(md, /estourou a janela/);
});

test("renderDiagnosticsBundle: bundle vazio não quebra e zera os contadores", () => {
  const md = renderDiagnosticsBundle([], { forgeVersion: "2.2.0" });
  assert.match(md, /Eventos capturados: 0/);
  assert.match(md, /Gerações: 0/);
});
