// Diagnóstico LOCAL (P3): converte os eventos de domínio (ObsEvent) num log estruturado NDJSON e num
// bundle legível para anexar a um relato de bug — SEM depender do Langfuse (que é opt-in + amostrado). É
// a mesma fonte de verdade (ObsEvent) apontada para um destino local, sempre-ligado e REDIGIDO. Puro/
// testável: o I/O (arquivo, globalStorage) e o buffer ficam em LocalDiagnosticsLog; a fiação, no Controller.
import { CaptureMode, ObsEvent } from "./types";
import { mask, maskUserId } from "./langfuseMap";

export interface DiagnosticRecord {
  ts: string;
  type: string;
  [k: string]: unknown;
}

// Mapeia um ObsEvent para um registro estruturado e REDIGIDO (uma linha NDJSON). Campos de conteúdo livre
// (input/output da geração) passam por mask() — segredos/PII colados no prompt não vazam. Reusa a mesma
// redação do sink do Langfuse (langfuseMap), então o bundle herda as garantias do RNF-001. Puro.
export function toDiagnosticRecord(e: ObsEvent, nowIso: string, capture: CaptureMode): DiagnosticRecord {
  const base: DiagnosticRecord = { ts: nowIso, type: e.type };
  switch (e.type) {
    case "generation.start":
      return { ...base, taskId: e.taskId, mode: e.mode, model: e.model, provider: e.provider, skills: e.skills, sessionId: e.sessionId, userId: maskUserId(e.userId, capture), org: e.org };
    case "generation.end":
      return { ...base, taskId: e.taskId, model: e.model, durationMs: e.durationMs, proposals: e.proposals, usage: e.usage, error: e.error, input: mask(e.input, capture), output: mask(e.output, capture) };
    case "skill.activated":
      return { ...base, skill: e.skill };
    case "proposal.created":
      return { ...base, filePath: e.filePath, change: e.change, language: e.language };
    case "proposal.applied":
    case "proposal.discarded":
      return { ...base, filePath: e.filePath };
    case "validation.result":
      return { ...base, filePath: e.filePath, gateOk: e.gateOk, validators: e.validators };
    case "run.result":
      return { ...base, filePath: e.filePath, label: e.label, ok: e.ok, exitCode: e.exitCode, durationMs: e.durationMs };
    case "profile.roleSet":
      return { ...base, role: e.role };
    case "review.done":
    case "profile.ruleAdded":
      return base;
    default:
      return base;
  }
}

// Renderiza o bundle de diagnóstico (markdown legível): manifesto do ambiente (versões/config NÃO-secreta),
// um resumo acionável (gerações, erros, reprovações de gate) e os eventos brutos em NDJSON. Puro/determinístico.
export function renderDiagnosticsBundle(records: DiagnosticRecord[], manifest: Record<string, unknown>): string {
  const count = (t: string) => records.filter((r) => r.type === t).length;
  const errors = records.filter((r) => r.type === "generation.end" && r.error);
  const gateFails = records.filter((r) => r.type === "validation.result" && r.gateOk === false);

  const lines: string[] = [];
  lines.push("# FORGE — Bundle de diagnóstico");
  lines.push("");
  lines.push("Artefato REDIGIDO (segredos/PII mascarados) para anexar a um relato de bug. Gerado localmente — nada é enviado a lugar nenhum ao criar este arquivo.");
  lines.push("");
  lines.push("## Ambiente");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(manifest, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("## Resumo");
  lines.push("");
  lines.push(`- Eventos capturados: ${records.length}`);
  lines.push(`- Gerações: ${count("generation.start")}`);
  lines.push(`- Erros de geração: ${errors.length}`);
  lines.push(`- Reprovações de gate: ${gateFails.length}`);
  lines.push(`- Propostas criadas: ${count("proposal.created")} · aplicadas: ${count("proposal.applied")} · descartadas: ${count("proposal.discarded")}`);
  lines.push("");
  lines.push(`## Eventos (${records.length})`);
  lines.push("");
  lines.push("Um evento por linha (NDJSON), em ordem cronológica:");
  lines.push("");
  lines.push("```");
  for (const r of records) lines.push(JSON.stringify(r));
  lines.push("```");
  return lines.join("\n");
}
