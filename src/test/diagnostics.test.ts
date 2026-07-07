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

// ---- P3: captura do prompt + params + spans de fase ----------------------------

test("toDiagnosticRecord: generation.start captura params e MASCARA o systemPrompt (evidência nº1)", () => {
  const e: ObsEvent = {
    type: "generation.start",
    taskId: "t1",
    mode: "project",
    model: "gpt-oss-120b",
    provider: "openai",
    skills: [],
    sessionId: "s1",
    userId: "dev@claro.com.br",
    // Dois estilos de segredo: sk-ant… (mask pega) e AWS_SECRET_ACCESS_KEY=… (só redactSecrets pega).
    systemPrompt: "Você é o FORGE. sk-ant-abc123def456ghi789 e AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI7K7bPxRfiCY0KEY.",
    systemPromptTokens: 4321,
    reasoningEffort: "high",
    maxOutputTokens: 32000,
    inputBudgetTokens: 90000,
  };
  const r = toDiagnosticRecord(e, TS, "masked");
  assert.equal(r.reasoningEffort, "high");
  assert.equal(r.maxOutputTokens, 32000);
  assert.equal(r.inputBudgetTokens, 90000);
  assert.equal(r.systemPromptTokens, 4321);
  // o prompt é capturado, mas segredos colados nele são redigidos em DUAS camadas (redactSecrets + mask)
  assert.match(String(r.systemPrompt), /Você é o FORGE/);
  assert.doesNotMatch(String(r.systemPrompt), /sk-ant-abc123def456ghi789/); // mask
  assert.doesNotMatch(String(r.systemPrompt), /wJalrXUtnFEMI7K7bPxRfiCY0KEY/); // redactSecrets (mask sozinho perderia)
});

test("toDiagnosticRecord: generation.start em metadata-only OMITE o systemPrompt", () => {
  const e: ObsEvent = { type: "generation.start", taskId: "t1", mode: "normal", model: "m", provider: "p", skills: [], sessionId: "s", userId: "u", systemPrompt: "segredo do prompt", reasoningEffort: "low" };
  const r = toDiagnosticRecord(e, TS, "metadata-only");
  assert.equal(r.systemPrompt, undefined); // conteúdo omitido
  assert.equal(r.reasoningEffort, "low"); // params seguem (não são conteúdo)
});

test("toDiagnosticRecord: phase.timing mapeia fase e duração", () => {
  const r = toDiagnosticRecord({ type: "phase.timing", taskId: "t1", phase: "stream", durationMs: 4200 }, TS, "masked");
  assert.equal(r.type, "phase.timing");
  assert.equal(r.phase, "stream");
  assert.equal(r.durationMs, 4200);
});

test("renderDiagnosticsBundle: resumo de fases agrega por fase (total/média) e params da última geração", () => {
  const records = [
    toDiagnosticRecord({ type: "generation.start", taskId: "t1", mode: "project", model: "m", provider: "p", skills: [], sessionId: "s", userId: "u", reasoningEffort: "high", maxOutputTokens: 16000, inputBudgetTokens: 80000, systemPromptTokens: 5000 }, TS, "masked"),
    toDiagnosticRecord({ type: "phase.timing", taskId: "t1", phase: "assemble", durationMs: 100 }, TS, "masked"),
    toDiagnosticRecord({ type: "phase.timing", taskId: "t1", phase: "stream", durationMs: 3000 }, TS, "masked"),
    toDiagnosticRecord({ type: "phase.timing", taskId: "t1", phase: "stream", durationMs: 1000 }, TS, "masked"), // 2 streams → média 2000
    toDiagnosticRecord({ type: "phase.timing", taskId: "t1", phase: "gate", durationMs: 500 }, TS, "masked"),
  ];
  const md = renderDiagnosticsBundle(records, { forgeVersion: "2.3.0" });
  assert.match(md, /## Fases \(timings\)/);
  assert.match(md, /stream: 2× · total 4000ms · média 2000ms/);
  assert.match(md, /gate: 1× · total 500ms · média 500ms/);
  // params efetivos da última geração no resumo
  assert.match(md, /reasoningEffort=high/);
  assert.match(md, /maxOutputTokens=16000/);
  assert.match(md, /systemPromptTokens=5000/);
});

test("renderDiagnosticsBundle: sem spans de fase → seção informa ausência (não quebra)", () => {
  const md = renderDiagnosticsBundle([toDiagnosticRecord({ type: "proposal.applied", filePath: "a.py" }, TS, "masked")], { forgeVersion: "2.3.0" });
  assert.match(md, /## Fases \(timings\)/);
  assert.match(md, /sem spans de fase capturados/);
});
