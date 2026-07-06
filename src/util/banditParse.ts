// Gate de SEGURANÇA (P2): o código gerado pode compilar, tipar e estar "pronto" e ainda embutir uma
// vulnerabilidade — eval/exec de input, subprocess com shell=True, injeção de comando. O bandit (SAST do
// PyCQA) reconhece esses padrões por AST (não EXECUTA o código). Este módulo é PURO: parseia o relatório
// JSON do bandit e decide, de forma CONSERVADORA, o que BLOQUEIA vs o que é ADVISORY.
//
// CONSERVADORISMO (lição da revisão adversarial): "severidade ALTA + confiança ALTA" NÃO é, sozinho, um
// subconjunto de alta precisão — há testes HIGH+HIGH que mordem código LEGÍTIMO (B324 md5/sha1 para
// etag/cache; B701 autoescape default do Jinja2). Por isso o BLOQUEIO exige, ALÉM de HIGH+HIGH, que o
// test_id esteja numa ALLOWLIST curada de padrões de EXECUÇÃO DE CÓDIGO / INJEÇÃO DE SHELL — a classe onde
// um achado quase nunca é falso-positivo. Todo o resto é ADVISORY. Erro seguro = NÃO bloquear.

export type Sev = "LOW" | "MEDIUM" | "HIGH" | "UNDEFINED";
export type SecurityMode = "conservative" | "advisory";

export interface BanditFinding {
  path: string;
  line: number;
  testId: string; // ex.: "B602"
  testName: string; // ex.: "subprocess_popen_with_shell_equals_true"
  severity: Sev;
  confidence: Sev;
  message: string;
}

// Test_ids que BLOQUEIAM (quando HIGH+HIGH): só EXECUÇÃO DE CÓDIGO / INJEÇÃO DE SHELL de altíssima precisão.
// Deliberadamente NÃO inclui B324 (md5/sha1, comum e legítimo p/ etag/cache/checksum) nem B701 (autoescape
// default do Jinja2) — HIGH+HIGH que mordem código gerado normal. Tudo fora desta lista é ADVISORY.
//   B102 exec_used · B307 eval · B602 subprocess shell=True · B604 any_other_function_with_shell_equals_true
//   B605 start_process_with_a_shell · B609 linux_commands_wildcard_injection
const BLOCKING_TESTS = new Set(["B102", "B307", "B602", "B604", "B605", "B609"]);

function normSev(v: unknown): Sev {
  const s = String(v ?? "").toUpperCase();
  return s === "HIGH" || s === "MEDIUM" || s === "LOW" ? s : "UNDEFINED";
}

// Um achado BLOQUEIA (modo conservador) só quando é HIGH+HIGH E o test_id está na allowlist de execução de
// código/shell — o subconjunto de altíssima precisão. Qualquer outra coisa é advisory.
export function isBlockingFinding(f: BanditFinding): boolean {
  return f.severity === "HIGH" && f.confidence === "HIGH" && BLOCKING_TESTS.has(f.testId);
}

// Extrai o objeto JSON do relatório. Recebe o CONTEÚDO DO ARQUIVO de relatório do bandit (`-o`), que é JSON
// PURO — logo o parse do texto inteiro resolve o caso normal. Fallback de recorte só como defesa. Strip de
// BOM. Falha → null.
function extractJson(raw: string): unknown | null {
  const s = (raw ?? "").replace(/^﻿/, "").trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    /* defensivo: recorta do primeiro { ao último } */
  }
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

// Parseia o relatório do bandit num vetor de achados. Distingue três estados (crucial para NÃO tratar um
// relatório ausente/truncado como "0 achados"): retorna `null` quando NÃO há relatório válido (bandit não
// rodou / crashou / arquivo truncado) — o chamador degrada para fail-open; `[]` quando rodou e nada achou;
// `[...]` com os achados. PURO. Nunca lança.
export function parseBanditReport(raw: string): BanditFinding[] | null {
  const doc = extractJson(raw) as { results?: unknown } | null;
  if (!doc || !Array.isArray(doc.results)) return null; // sem relatório válido → indisponível (fail-open)
  const out: BanditFinding[] = [];
  for (const r of doc.results as any[]) {
    const path = String(r?.filename ?? "").trim();
    if (!path) continue;
    out.push({
      path,
      line: Number(r?.line_number) || 0,
      testId: String(r?.test_id ?? "").trim(),
      testName: String(r?.test_name ?? "").trim(),
      severity: normSev(r?.issue_severity),
      confidence: normSev(r?.issue_confidence),
      message: String(r?.issue_text ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
    });
  }
  return out;
}

// Separa os achados em BLOQUEANTES (agrupados por arquivo — só no modo conservador, via allowlist) e
// ADVISORY (os demais, ou TODOS no modo advisory). PURO. `blocking` no formato {path, errors[]} do gate;
// `advisories` são linhas legíveis. Os paths já vêm NORMALIZADOS pelo chamador.
export function splitSecurityFindings(
  findings: BanditFinding[],
  mode: SecurityMode
): { blocking: { path: string; errors: string[] }[]; advisories: string[] } {
  const blockingSet = new Set<BanditFinding>(mode === "conservative" ? findings.filter(isBlockingFinding) : []);
  const byPath = new Map<string, string[]>();
  for (const f of findings) {
    if (!blockingSet.has(f)) continue;
    const arr = byPath.get(f.path) ?? [];
    arr.push(`bandit ${f.testId}${f.testName ? ` (${f.testName})` : ""} — severidade ${f.severity}/confiança ${f.confidence}, linha ${f.line}: ${f.message}`);
    byPath.set(f.path, arr);
  }
  const blocking = [...byPath]
    .map(([path, errors]) => ({ path, errors }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const advisories = findings
    .filter((f) => !blockingSet.has(f))
    .map((f) => `${f.path}:${f.line} — bandit ${f.testId} (${f.severity}/${f.confidence}): ${f.message}`)
    .sort();
  return { blocking, advisories };
}
