// Diagnóstico LOCAL (P3): converte os eventos de domínio (ObsEvent) num log estruturado NDJSON e num
// bundle legível para anexar a um relato de bug — SEM depender do Langfuse (que é opt-in + amostrado). É
// a mesma fonte de verdade (ObsEvent) apontada para um destino local, sempre-ligado e REDIGIDO. Puro/
// testável: o I/O (arquivo, globalStorage) e o buffer ficam em LocalDiagnosticsLog; a fiação, no Controller.
import { CaptureMode, ObsEvent } from "./types";
import { mask, maskUserId } from "./langfuseMap";
import { redactSecrets } from "../util/redact";

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
      // P3: o prompt de sistema montado + os params efetivos — a evidência direta de "que prompt/params
      // produziram esta geração". O prompt agrega perfil/RAG/anexos, então é REDIGIDO em duas camadas antes
      // de ir ao log local: redactSecrets (key-based: API_KEY=/PASSWORD=/Bearer…) + mask (padrões + cap). É
      // best-effort (defesa em profundidade), e o log é LOCAL/redigido — distinto do egress remoto, que só
      // recebe o prompt em capture 'full'.
      return {
        ...base,
        taskId: e.taskId,
        mode: e.mode,
        model: e.model,
        provider: e.provider,
        skills: e.skills,
        sessionId: e.sessionId,
        userId: maskUserId(e.userId, capture),
        org: e.org,
        systemPrompt: e.systemPrompt === undefined ? undefined : mask(redactSecrets(e.systemPrompt), capture),
        systemPromptTokens: e.systemPromptTokens,
        reasoningEffort: e.reasoningEffort,
        maxOutputTokens: e.maxOutputTokens,
        inputBudgetTokens: e.inputBudgetTokens,
      };
    case "phase.timing":
      return { ...base, taskId: e.taskId, phase: e.phase, durationMs: e.durationMs };
    case "generation.end":
      return { ...base, taskId: e.taskId, model: e.model, durationMs: e.durationMs, proposals: e.proposals, usage: e.usage, error: e.error, input: mask(e.input, capture), output: mask(e.output, capture) };
    case "skill.activated":
      return { ...base, skill: e.skill };
    case "proposal.created":
      return { ...base, filePath: e.filePath, change: e.change, language: e.language };
    case "proposal.applied":
      return { ...base, filePath: e.filePath, forced: e.forced };
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
  // P3: params da geração mais RECENTE (config efetiva) e agregação dos spans de fase (onde o tempo vai).
  const lastGen = [...records].reverse().find((r) => r.type === "generation.start");
  const num = (v: unknown) => (typeof v === "number" ? String(v) : "?");
  const phaseAgg = new Map<string, { n: number; total: number }>();
  for (const r of records) {
    if (r.type !== "phase.timing") continue;
    const ph = String(r.phase ?? "?");
    const d = typeof r.durationMs === "number" ? r.durationMs : 0;
    const cur = phaseAgg.get(ph) ?? { n: 0, total: 0 };
    cur.n += 1;
    cur.total += d;
    phaseAgg.set(ph, cur);
  }

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
  if (lastGen) {
    lines.push(
      `- Última geração (params efetivos): reasoningEffort=${lastGen.reasoningEffort ?? "?"} · maxOutputTokens=${num(lastGen.maxOutputTokens)} · inputBudgetTokens=${num(lastGen.inputBudgetTokens)} · systemPromptTokens=${num(lastGen.systemPromptTokens)}`
    );
  }
  lines.push("");
  lines.push("## Fases (timings)");
  lines.push("");
  if (phaseAgg.size === 0) {
    lines.push("- (sem spans de fase capturados)");
  } else {
    // Ordem canônica do pipeline; fases ausentes são omitidas.
    const order = ["assemble", "rag", "stream", "continuation", "gate", "repair"];
    const seen = [...phaseAgg.keys()].sort((a, b) => (order.indexOf(a) - order.indexOf(b)) || a.localeCompare(b));
    for (const ph of seen) {
      const { n, total } = phaseAgg.get(ph)!;
      lines.push(`- ${ph}: ${n}× · total ${total}ms · média ${Math.round(total / n)}ms`);
    }
  }
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
