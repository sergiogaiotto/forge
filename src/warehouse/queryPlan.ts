import { createHash } from "node:crypto";
import type { WarehouseKind } from "./types";

export type QueryPlanMode = "estimate" | "observed";
export type PlanSeverity = "high" | "medium" | "low";

export interface QueryPlanMetrics {
  optimizerCost?: number;
  startupCost?: number;
  estimatedRows?: number;
  actualRows?: number;
  planningTimeMs?: number;
  executionTimeMs?: number;
  sharedHitBlocks?: number;
  sharedReadBlocks?: number;
  tempReadBlocks?: number;
  tempWrittenBlocks?: number;
  bytesProcessed?: number;
  bytesBilled?: number;
  slotMs?: number;
}

export interface QueryPlanOperator {
  name: string;
  relation?: string;
  estimatedRows?: number;
  actualRows?: number;
  loops?: number;
  totalCost?: number;
  timeMs?: number;
  sharedReadBlocks?: number;
  tempWrittenBlocks?: number;
}

export interface QueryPlanHotspot {
  severity: PlanSeverity;
  code: string;
  operator?: string;
  evidence: string;
  recommendation: string;
}

export interface QueryPlanInsight {
  kind: WarehouseKind;
  mode: QueryPlanMode;
  parser: "postgres-json" | "oracle-text" | "bigquery-json" | "duckdb-json" | "duckdb-text" | "generic";
  planHash: string;
  metrics: QueryPlanMetrics;
  operators: QueryPlanOperator[];
  hotspots: QueryPlanHotspot[];
  warnings: string[];
}

export interface QueryPlanMetricDelta {
  key: keyof QueryPlanMetrics;
  label: string;
  before: number;
  after: number;
  deltaPct?: number;
  unit: "count" | "ms" | "blocks" | "bytes" | "cost";
}

export interface QueryPlanComparison {
  verdict: "improvement" | "regression" | "mixed" | "inconclusive";
  metrics: QueryPlanMetricDelta[];
  resolvedHotspots: QueryPlanHotspot[];
  introducedHotspots: QueryPlanHotspot[];
}

type JsonObject = Record<string, unknown>;

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/,/g, "").trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function csvRows(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field.length === 0) {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field || row.length > 0) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

function balancedJson(source: string, start: number): string | undefined {
  const opener = source[start];
  if (opener !== "{" && opener !== "[") return undefined;
  const stack: string[] = [opener];
  let quoted = false;
  let escaped = false;
  for (let i = start + 1; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") {
      const expected = ch === "}" ? "{" : "[";
      if (stack.at(-1) !== expected) return undefined;
      stack.pop();
      if (stack.length === 0) return source.slice(start, i + 1);
    }
  }
  return undefined;
}

function jsonDocuments(raw: string): unknown[] {
  const sources = [raw, ...csvRows(raw).flat()].filter((value, index, all) => value.trim() && all.indexOf(value) === index);
  const out: unknown[] = [];
  for (const source of sources) {
    const trimmed = source.trim().replace(/^\uFEFF/, "");
    try {
      out.push(JSON.parse(trimmed));
      continue;
    } catch {
      // CLI output commonly wraps JSON in a heading or a CSV field.
    }
    for (let i = 0; i < source.length; i++) {
      if (source[i] !== "{" && source[i] !== "[") continue;
      const candidate = balancedJson(source, i);
      if (!candidate) continue;
      try {
        out.push(JSON.parse(candidate));
        i += candidate.length - 1;
      } catch {
        // Keep scanning for a later complete document.
      }
    }
  }
  return out;
}

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function deepValue(value: unknown, wanted: string[]): unknown {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = deepValue(item, wanted);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const object = value as JsonObject;
  for (const [key, candidate] of Object.entries(object)) {
    if (wanted.includes(key.toLowerCase())) return candidate;
  }
  for (const candidate of Object.values(object)) {
    const found = deepValue(candidate, wanted);
    if (found !== undefined) return found;
  }
  return undefined;
}

function pushHotspot(target: QueryPlanHotspot[], hotspot: QueryPlanHotspot): void {
  if (!target.some((item) => item.code === hotspot.code && item.operator === hotspot.operator && item.evidence === hotspot.evidence)) {
    target.push(hotspot);
  }
}

function estimateRatio(estimated: number | undefined, actual: number | undefined): number | undefined {
  if (estimated === undefined || actual === undefined) return undefined;
  if (estimated === 0) return actual === 0 ? 1 : Number.POSITIVE_INFINITY;
  return Math.max(actual / estimated, estimated / Math.max(actual, 1));
}

function parsePostgres(raw: string, mode: QueryPlanMode): QueryPlanInsight | undefined {
  const document = jsonDocuments(raw).find((value) => {
    const first = Array.isArray(value) ? value[0] : value;
    return !!asObject(first)?.Plan;
  });
  if (!document) return undefined;
  const statement = asObject(Array.isArray(document) ? document[0] : document);
  const root = asObject(statement?.Plan);
  if (!statement || !root) return undefined;

  const operators: QueryPlanOperator[] = [];
  const hotspots: QueryPlanHotspot[] = [];
  const visit = (node: JsonObject): void => {
    const name = textValue(node["Node Type"]) ?? "Unknown";
    const relation = textValue(node["Relation Name"]);
    const estimatedRows = finiteNumber(node["Plan Rows"]);
    const actualRows = finiteNumber(node["Actual Rows"]);
    const loops = finiteNumber(node["Actual Loops"]);
    const totalCost = finiteNumber(node["Total Cost"]);
    const actualTime = finiteNumber(node["Actual Total Time"]);
    const sharedReadBlocks = finiteNumber(node["Shared Read Blocks"]);
    const tempWrittenBlocks = finiteNumber(node["Temp Written Blocks"]);
    const label = relation ? `${name} on ${relation}` : name;
    operators.push({
      name,
      relation,
      estimatedRows,
      actualRows,
      loops,
      totalCost,
      timeMs: actualTime !== undefined ? actualTime * Math.max(loops ?? 1, 1) : undefined,
      sharedReadBlocks,
      tempWrittenBlocks,
    });

    const cardinality = actualRows !== undefined ? actualRows * Math.max(loops ?? 1, 1) : estimatedRows;
    if (/Seq Scan/i.test(name) && (cardinality ?? 0) >= 10_000) {
      pushHotspot(hotspots, {
        severity: (cardinality ?? 0) >= 1_000_000 ? "high" : "medium",
        code: "sequential-scan",
        operator: label,
        evidence: `${formatCount(cardinality)} linhas no scan`,
        recommendation: "Revise predicados sargáveis, seletividade, partições e índices existentes.",
      });
    }
    if (/Nested Loop/i.test(name) && (cardinality ?? 0) >= 100_000) {
      pushHotspot(hotspots, {
        severity: "high",
        code: "nested-loop-volume",
        operator: label,
        evidence: `${formatCount(cardinality)} linhas, ${formatCount(loops)} loops`,
        recommendation: "Revise cardinalidade do join, índices da chave interna e alternativas hash/merge join.",
      });
    }
    if ((tempWrittenBlocks ?? 0) > 0 || /external/i.test(textValue(node["Sort Method"]) ?? "")) {
      pushHotspot(hotspots, {
        severity: "high",
        code: "temp-spill",
        operator: label,
        evidence: `${formatCount(tempWrittenBlocks)} blocos temporários escritos`,
        recommendation: "Reduza o volume antes do sort/hash e revise work_mem somente após corrigir o plano.",
      });
    }
    const ratio = estimateRatio(estimatedRows, actualRows);
    if (mode === "observed" && ratio !== undefined && ratio >= 4) {
      pushHotspot(hotspots, {
        severity: ratio >= 10 ? "high" : "medium",
        code: "cardinality-error",
        operator: label,
        evidence: `estimativa ${formatCount(estimatedRows)} versus real ${formatCount(actualRows)} (${formatDecimal(ratio)}x)`,
        recommendation: "Atualize/revise estatísticas, correlação de colunas e distribuição dos filtros.",
      });
    }
    const removed = finiteNumber(node["Rows Removed by Filter"]);
    if ((removed ?? 0) > Math.max((actualRows ?? 0) * 5, 10_000)) {
      pushHotspot(hotspots, {
        severity: "medium",
        code: "late-filter",
        operator: label,
        evidence: `${formatCount(removed)} linhas removidas pelo filtro`,
        recommendation: "Empurre o filtro para a origem e torne o predicado indexável quando possível.",
      });
    }

    for (const child of Array.isArray(node.Plans) ? node.Plans : []) {
      const object = asObject(child);
      if (object) visit(object);
    }
  };
  visit(root);

  return {
    kind: "postgres",
    mode,
    parser: "postgres-json",
    planHash: hashPlan(raw),
    metrics: {
      startupCost: finiteNumber(root["Startup Cost"]),
      optimizerCost: finiteNumber(root["Total Cost"]),
      estimatedRows: finiteNumber(root["Plan Rows"]),
      actualRows: finiteNumber(root["Actual Rows"]),
      planningTimeMs: finiteNumber(statement["Planning Time"]),
      executionTimeMs: finiteNumber(statement["Execution Time"]),
      sharedHitBlocks: finiteNumber(root["Shared Hit Blocks"]),
      sharedReadBlocks: finiteNumber(root["Shared Read Blocks"]),
      tempReadBlocks: finiteNumber(root["Temp Read Blocks"]),
      tempWrittenBlocks: finiteNumber(root["Temp Written Blocks"]),
    },
    operators: operators.slice(0, 100),
    hotspots: hotspots.slice(0, 20),
    warnings: [],
  };
}

function oraclePlanText(raw: string): string {
  const rows = csvRows(raw);
  return rows.length > 1 ? rows.flat().join("\n") : raw;
}

function parseClockMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parts = value.trim().split(":").map(Number);
  if (parts.some((item) => !Number.isFinite(item))) return undefined;
  if (parts.length === 3) return ((parts[0] * 60 + parts[1]) * 60 + parts[2]) * 1000;
  const seconds = /^([\d.]+)\s*s$/i.exec(value.trim());
  return seconds ? Number(seconds[1]) * 1000 : undefined;
}

function parseOracle(raw: string, mode: QueryPlanMode): QueryPlanInsight | undefined {
  const text = oraclePlanText(raw);
  const lines = text.split(/\r?\n/);
  const headerAt = lines.findIndex((line) => /\|\s*(?:Id|Operation)\s*\|/i.test(line) && /\bOperation\b/i.test(line));
  if (headerAt < 0) return undefined;
  const split = (line: string) => line.split("|").slice(1, -1).map((part) => part.trim());
  const header = split(lines[headerAt]);
  const indexOf = (pattern: RegExp) => header.findIndex((value) => pattern.test(value));
  const idIndex = indexOf(/^Id$/i);
  const operationIndex = indexOf(/^Operation$/i);
  const nameIndex = indexOf(/^Name$/i);
  const rowsIndex = indexOf(/^(?:E-)?Rows$/i);
  const actualRowsIndex = indexOf(/^A-Rows$/i);
  const costIndex = indexOf(/^Cost/i);
  const timeIndex = indexOf(/^A-Time$|^Time$/i);
  const buffersIndex = indexOf(/^Buffers$/i);
  const readsIndex = indexOf(/^Reads$/i);
  if (operationIndex < 0) return undefined;

  const operators: QueryPlanOperator[] = [];
  const hotspots: QueryPlanHotspot[] = [];
  for (const line of lines.slice(headerAt + 1)) {
    if (!line.includes("|") || /^\s*\+-/.test(line)) continue;
    const cols = split(line);
    if (cols.length !== header.length || !cols[operationIndex]) continue;
    const name = cols[operationIndex].replace(/^\s*\*?\s*/, "").trim();
    if (!name || /^[- ]+$/.test(name)) continue;
    const relation = nameIndex >= 0 ? textValue(cols[nameIndex]) : undefined;
    const estimatedRows = rowsIndex >= 0 ? finiteNumber(cols[rowsIndex]) : undefined;
    const actualRows = actualRowsIndex >= 0 ? finiteNumber(cols[actualRowsIndex]) : undefined;
    const cost = costIndex >= 0 ? finiteNumber(cols[costIndex]?.match(/[\d.]+/)?.[0]) : undefined;
    const operator: QueryPlanOperator = {
      name,
      relation,
      estimatedRows,
      actualRows,
      totalCost: cost,
      timeMs: timeIndex >= 0 ? parseClockMs(cols[timeIndex]) : undefined,
      sharedReadBlocks: readsIndex >= 0 ? finiteNumber(cols[readsIndex]) : undefined,
    };
    operators.push(operator);
    const label = relation ? `${name} on ${relation}` : name;
    if (/TABLE ACCESS FULL/i.test(name) && (actualRows ?? estimatedRows ?? 0) >= 10_000) {
      pushHotspot(hotspots, {
        severity: (actualRows ?? estimatedRows ?? 0) >= 1_000_000 ? "high" : "medium",
        code: "full-table-scan",
        operator: label,
        evidence: `${formatCount(actualRows ?? estimatedRows)} linhas`,
        recommendation: "Revise seletividade, predicados, partições e índices antes de sugerir um índice novo.",
      });
    }
    if (/MERGE JOIN CARTESIAN|CARTESIAN/i.test(name)) {
      pushHotspot(hotspots, {
        severity: "high",
        code: "cartesian-join",
        operator: label,
        evidence: "operador cartesiano presente no plano",
        recommendation: "Confirme a condição de join e a granularidade esperada.",
      });
    }
    if (/PARTITION RANGE ALL/i.test(name)) {
      pushHotspot(hotspots, {
        severity: "high",
        code: "partition-scan-all",
        operator: label,
        evidence: "todas as partições são acessadas",
        recommendation: "Use filtro compatível com a chave de partição e evite funções sobre a coluna.",
      });
    }
    const ratio = estimateRatio(estimatedRows, actualRows);
    if (mode === "observed" && ratio !== undefined && ratio >= 4) {
      pushHotspot(hotspots, {
        severity: ratio >= 10 ? "high" : "medium",
        code: "cardinality-error",
        operator: label,
        evidence: `estimativa ${formatCount(estimatedRows)} versus real ${formatCount(actualRows)} (${formatDecimal(ratio)}x)`,
        recommendation: "Revise estatísticas, histograms e correlação das colunas filtradas.",
      });
    }
    if (idIndex >= 0 && cols[idIndex]?.replace(/\D/g, "") === "0" && operators.length > 1) break;
  }
  if (operators.length === 0) return undefined;
  const root = operators[0];
  const reads = operators.reduce((sum, operator) => sum + (operator.sharedReadBlocks ?? 0), 0);
  const buffers = buffersIndex >= 0
    ? lines.slice(headerAt + 1).reduce((sum, line) => {
        const cols = line.includes("|") ? split(line) : [];
        return sum + (cols.length === header.length ? finiteNumber(cols[buffersIndex]) ?? 0 : 0);
      }, 0)
    : undefined;
  return {
    kind: "oracle",
    mode,
    parser: "oracle-text",
    planHash: hashPlan(raw),
    metrics: {
      optimizerCost: root.totalCost,
      estimatedRows: root.estimatedRows,
      actualRows: root.actualRows,
      executionTimeMs: root.timeMs,
      sharedHitBlocks: buffers,
      sharedReadBlocks: reads || undefined,
    },
    operators: operators.slice(0, 100),
    hotspots: hotspots.slice(0, 20),
    warnings: mode === "estimate"
      ? ["O custo Oracle é uma unidade relativa do otimizador, não tempo ou moeda."]
      : ["As métricas observadas vêm do último cursor equivalente disponível em V$SQL; confirme quando ele foi executado."],
  };
}

function parseBigQuery(raw: string, mode: QueryPlanMode): QueryPlanInsight | undefined {
  const documents = jsonDocuments(raw);
  const source = documents.find((value) =>
    deepValue(value, ["totalbytesprocessed", "totalbytesbilled", "totalslotms"]) !== undefined
  );
  const csv = csvRows(raw);
  const header = csv[0]?.map((value) => value.trim().toLowerCase().replace(/_/g, ""));
  const data = csv[1];
  const csvMetric = (names: string[]): number | undefined => {
    if (!header || !data) return undefined;
    const index = header.findIndex((name) => names.includes(name));
    return index >= 0 ? finiteNumber(data[index]) : undefined;
  };
  const regexNumber = (pattern: RegExp) => finiteNumber(pattern.exec(raw)?.[1]);
  const bytesProcessed =
    finiteNumber(deepValue(source, ["totalbytesprocessed", "total_bytes_processed"])) ??
    csvMetric(["totalbytesprocessed"]) ??
    regexNumber(/total[_ ]?bytes[_ ]?processed["']?\s*[:=]\s*["']?(\d+)/i);
  const bytesBilled =
    finiteNumber(deepValue(source, ["totalbytesbilled", "total_bytes_billed"])) ??
    csvMetric(["totalbytesbilled"]) ??
    regexNumber(/total[_ ]?bytes[_ ]?billed["']?\s*[:=]\s*["']?(\d+)/i);
  const slotMs =
    finiteNumber(deepValue(source, ["totalslotms", "total_slot_ms"])) ??
    csvMetric(["totalslotms"]) ??
    regexNumber(/total[_ ]?slot[_ ]?ms["']?\s*[:=]\s*["']?(\d+)/i);
  const executionTimeMs =
    finiteNumber(deepValue(source, ["executiontimems", "execution_time_ms"])) ??
    csvMetric(["executiontimems"]);
  if (bytesProcessed === undefined && bytesBilled === undefined && slotMs === undefined) return undefined;
  const hotspots: QueryPlanHotspot[] = [];
  if ((bytesProcessed ?? 0) >= 100 * 1024 ** 3) {
    pushHotspot(hotspots, {
      severity: (bytesProcessed ?? 0) >= 1024 ** 4 ? "high" : "medium",
      code: "large-scan",
      evidence: `${formatBytes(bytesProcessed)} processados`,
      recommendation: "Revise filtro de partição, projeção de colunas e tabelas intermediárias materializadas.",
    });
  }
  return {
    kind: "bigquery",
    mode,
    parser: "bigquery-json",
    planHash: hashPlan(raw),
    metrics: { bytesProcessed, bytesBilled, slotMs, executionTimeMs },
    operators: [],
    hotspots,
    warnings: [
      "Bytes processados podem ser convertidos em moeda somente com a tabela de preços do contrato/projeto.",
      ...(mode === "observed" ? ["As métricas observadas vêm do último job equivalente encontrado nos últimos 30 dias."] : []),
    ],
  };
}

function parseDuckDb(raw: string, mode: QueryPlanMode): QueryPlanInsight | undefined {
  const document = jsonDocuments(raw).find((value) => {
    const first = Array.isArray(value) ? value[0] : value;
    const object = asObject(first);
    return !!object && (typeof object.name === "string" || Array.isArray(object.children));
  });
  if (document) {
    const roots = Array.isArray(document) ? document : [document];
    const operators: QueryPlanOperator[] = [];
    const hotspots: QueryPlanHotspot[] = [];
    const visit = (value: unknown): void => {
      const node = asObject(value);
      if (!node) return;
      const name = textValue(node.name) ?? textValue(node.operator_name) ?? "Unknown";
      const extra = asObject(node.extra_info) ?? {};
      const estimatedRows =
        finiteNumber(extra["Estimated Cardinality"]) ??
        finiteNumber(node.estimated_cardinality) ??
        finiteNumber(node.cardinality);
      const timeMs = finiteNumber(node.operator_timing) !== undefined ? finiteNumber(node.operator_timing)! * 1000 : undefined;
      operators.push({ name, estimatedRows, actualRows: finiteNumber(node.operator_cardinality), timeMs });
      if (/SEQ_SCAN|TABLE_SCAN/i.test(name) && (estimatedRows ?? 0) >= 10_000) {
        pushHotspot(hotspots, {
          severity: (estimatedRows ?? 0) >= 1_000_000 ? "high" : "medium",
          code: "sequential-scan",
          operator: name,
          evidence: `${formatCount(estimatedRows)} linhas estimadas`,
          recommendation: "Projete e filtre cedo; considere ordenação/particionamento do arquivo ou persistência local.",
        });
      }
      if (/CROSS_PRODUCT/i.test(name)) {
        pushHotspot(hotspots, {
          severity: "high",
          code: "cartesian-join",
          operator: name,
          evidence: "CROSS_PRODUCT no plano",
          recommendation: "Confirme a condição de join e a granularidade esperada.",
        });
      }
      for (const child of Array.isArray(node.children) ? node.children : []) visit(child);
    };
    roots.forEach(visit);
    const totalTime = finiteNumber(deepValue(document, ["latency", "execution_time", "total_time"]));
    return {
      kind: "duckdb",
      mode,
      parser: "duckdb-json",
      planHash: hashPlan(raw),
      metrics: {
        estimatedRows: operators[0]?.estimatedRows,
        actualRows: operators[0]?.actualRows,
        executionTimeMs: totalTime !== undefined ? totalTime * 1000 : undefined,
      },
      operators: operators.slice(0, 100),
      hotspots: hotspots.slice(0, 20),
      warnings: [],
    };
  }

  const totalSeconds = finiteNumber(/Total Time:\s*([\d.]+)s/i.exec(raw)?.[1]);
  if (totalSeconds === undefined && !/EXPLAIN_ANALYZE|QUERY|TABLE_SCAN|SEQ_SCAN/i.test(raw)) return undefined;
  const hotspots: QueryPlanHotspot[] = [];
  if (/CROSS_PRODUCT/i.test(raw)) {
    hotspots.push({
      severity: "high",
      code: "cartesian-join",
      evidence: "CROSS_PRODUCT no plano",
      recommendation: "Confirme a condição de join e a granularidade esperada.",
    });
  }
  return {
    kind: "duckdb",
    mode,
    parser: "duckdb-text",
    planHash: hashPlan(raw),
    metrics: { executionTimeMs: totalSeconds !== undefined ? totalSeconds * 1000 : undefined },
    operators: [],
    hotspots,
    warnings: [],
  };
}

export function parseQueryPlan(kind: WarehouseKind, raw: string, mode: QueryPlanMode = "estimate"): QueryPlanInsight {
  const parsed =
    (kind === "postgres" ? parsePostgres(raw, mode) : undefined) ??
    (kind === "oracle" ? parseOracle(raw, mode) : undefined) ??
    (kind === "bigquery" ? parseBigQuery(raw, mode) : undefined) ??
    (kind === "duckdb" ? parseDuckDb(raw, mode) : undefined);
  return parsed ?? {
    kind,
    mode,
    parser: "generic",
    planHash: hashPlan(raw),
    metrics: {},
    operators: [],
    hotspots: [],
    warnings: ["O plano foi obtido, mas este formato não pôde ser estruturado; revise o plano bruto."],
  };
}

function hashPlan(raw: string): string {
  return createHash("sha256").update(raw.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 16);
}

function formatDecimal(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "-";
  if (Math.abs(value) >= 1000) return Math.round(value).toLocaleString("pt-BR");
  return value.toLocaleString("pt-BR", { maximumFractionDigits: 2 });
}

export function formatCount(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "-";
  return Math.round(value).toLocaleString("pt-BR");
}

export function formatBytes(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "-";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let current = Math.max(0, value);
  let unit = 0;
  while (current >= 1024 && unit < units.length - 1) {
    current /= 1024;
    unit++;
  }
  return `${current.toLocaleString("pt-BR", { maximumFractionDigits: 2 })} ${units[unit]}`;
}

function metricRows(metrics: QueryPlanMetrics): string[] {
  const rows: string[] = [];
  const add = (label: string, value: string | undefined) => {
    if (value !== undefined) rows.push(`| ${label} | ${value} |`);
  };
  add("Custo do otimizador", metrics.optimizerCost !== undefined ? formatDecimal(metrics.optimizerCost) : undefined);
  add("Linhas estimadas", metrics.estimatedRows !== undefined ? formatCount(metrics.estimatedRows) : undefined);
  add("Linhas observadas", metrics.actualRows !== undefined ? formatCount(metrics.actualRows) : undefined);
  add("Planejamento", metrics.planningTimeMs !== undefined ? `${formatDecimal(metrics.planningTimeMs)} ms` : undefined);
  add("Execução", metrics.executionTimeMs !== undefined ? `${formatDecimal(metrics.executionTimeMs)} ms` : undefined);
  add("Blocos em cache", metrics.sharedHitBlocks !== undefined ? formatCount(metrics.sharedHitBlocks) : undefined);
  add("Blocos lidos", metrics.sharedReadBlocks !== undefined ? formatCount(metrics.sharedReadBlocks) : undefined);
  add("Blocos temporários lidos", metrics.tempReadBlocks !== undefined ? formatCount(metrics.tempReadBlocks) : undefined);
  add("Blocos temporários escritos", metrics.tempWrittenBlocks !== undefined ? formatCount(metrics.tempWrittenBlocks) : undefined);
  add("Bytes processados", metrics.bytesProcessed !== undefined ? formatBytes(metrics.bytesProcessed) : undefined);
  add("Bytes faturados", metrics.bytesBilled !== undefined ? formatBytes(metrics.bytesBilled) : undefined);
  add("Slot time", metrics.slotMs !== undefined ? `${formatCount(metrics.slotMs)} ms` : undefined);
  return rows;
}

function safeRaw(raw: string, cap = 8_000): string {
  const clipped = raw.length > cap ? `${raw.slice(0, cap)}\n... (plano bruto truncado pelo cockpit)` : raw;
  return clipped.replace(/```/g, "'''");
}

export function renderQueryPlanCockpit(
  connectionId: string,
  insight: QueryPlanInsight,
  raw: string,
  opts?: { command?: string; durationMs?: number; includeRaw?: boolean }
): string {
  const metrics = metricRows(insight.metrics);
  const hotspots = insight.hotspots.length > 0
    ? insight.hotspots.map(
        (item) =>
          `- **${item.severity.toUpperCase()} · ${item.code}**${item.operator ? ` · \`${item.operator}\`` : ""}: ${item.evidence}. ${item.recommendation}`
      )
    : ["- Nenhum hotspot de alta confiança foi identificado automaticamente."];
  const mode =
    insight.mode === "observed"
      ? "observado, por EXPLAIN ANALYZE ou histórico do motor"
      : "estimado, não executou o SELECT";
  const costNote =
    insight.metrics.optimizerCost !== undefined
      ? "_O custo do otimizador é uma unidade interna do banco; não equivale diretamente a tempo ou dinheiro._"
      : "";
  return [
    `### Query Cost Cockpit · \`${connectionId}\``,
    "",
    `**Modo:** ${mode}  `,
    `**Parser:** \`${insight.parser}\` · **Plan hash:** \`${insight.planHash}\``,
    "",
    ...(metrics.length > 0 ? ["| Métrica | Valor |", "|---|---:|", ...metrics] : ["_O banco não devolveu métricas normalizáveis neste formato._"]),
    "",
    "#### Hotspots",
    ...hotspots,
    ...(insight.warnings.length > 0 ? ["", "#### Limitações", ...insight.warnings.map((warning) => `- ${warning}`)] : []),
    ...(costNote ? ["", costNote] : []),
    ...(opts?.command
      ? ["", `\`${opts.command}\`${opts.durationMs !== undefined ? ` · ${(opts.durationMs / 1000).toFixed(1)}s` : ""}`]
      : []),
    ...(opts?.includeRaw === false ? [] : ["", "#### Plano bruto", "```text", safeRaw(raw), "```"]),
  ].join("\n");
}

const COMPARABLE_METRICS: Array<{
  key: keyof QueryPlanMetrics;
  label: string;
  unit: QueryPlanMetricDelta["unit"];
}> = [
  { key: "optimizerCost", label: "Custo do otimizador", unit: "cost" },
  { key: "executionTimeMs", label: "Tempo de execução", unit: "ms" },
  { key: "sharedReadBlocks", label: "Blocos lidos", unit: "blocks" },
  { key: "tempReadBlocks", label: "Blocos temporários lidos", unit: "blocks" },
  { key: "tempWrittenBlocks", label: "Blocos temporários escritos", unit: "blocks" },
  { key: "bytesProcessed", label: "Bytes processados", unit: "bytes" },
  { key: "bytesBilled", label: "Bytes faturados", unit: "bytes" },
  { key: "slotMs", label: "Slot time", unit: "ms" },
];

export function compareQueryPlans(before: QueryPlanInsight, after: QueryPlanInsight): QueryPlanComparison {
  const metrics: QueryPlanMetricDelta[] = [];
  for (const spec of COMPARABLE_METRICS) {
    const a = before.metrics[spec.key];
    const b = after.metrics[spec.key];
    if (typeof a !== "number" || typeof b !== "number") continue;
    metrics.push({
      ...spec,
      before: a,
      after: b,
      deltaPct: a === 0 ? (b === 0 ? 0 : undefined) : ((b - a) / Math.abs(a)) * 100,
    });
  }
  const deltas = metrics.map((metric) => metric.deltaPct).filter((value): value is number => value !== undefined);
  const improved = deltas.some((value) => value <= -5);
  const regressed = deltas.some((value) => value >= 5);
  const verdict =
    metrics.length === 0 ? "inconclusive" : improved && regressed ? "mixed" : regressed ? "regression" : improved ? "improvement" : "inconclusive";
  const beforeCodes = new Set(before.hotspots.map((item) => item.code));
  const afterCodes = new Set(after.hotspots.map((item) => item.code));
  return {
    verdict,
    metrics,
    resolvedHotspots: before.hotspots.filter((item) => !afterCodes.has(item.code)),
    introducedHotspots: after.hotspots.filter((item) => !beforeCodes.has(item.code)),
  };
}

function formatMetric(value: number, unit: QueryPlanMetricDelta["unit"]): string {
  if (unit === "bytes") return formatBytes(value);
  if (unit === "ms") return `${formatDecimal(value)} ms`;
  return formatDecimal(value);
}

export function renderQueryPlanComparison(
  connectionId: string,
  originalPath: string,
  tunedPath: string,
  before: QueryPlanInsight,
  after: QueryPlanInsight
): string {
  const comparison = compareQueryPlans(before, after);
  const verdict =
    comparison.verdict === "improvement"
      ? "melhoria estimada"
      : comparison.verdict === "regression"
        ? "regressão estimada"
        : comparison.verdict === "mixed"
          ? "resultado misto"
          : "inconclusivo";
  const rows = comparison.metrics.map((metric) => {
    const delta = metric.deltaPct === undefined ? "-" : `${metric.deltaPct > 0 ? "+" : ""}${formatDecimal(metric.deltaPct)}%`;
    return `| ${metric.label} | ${formatMetric(metric.before, metric.unit)} | ${formatMetric(metric.after, metric.unit)} | ${delta} |`;
  });
  return [
    `### Comparação de planos · \`${connectionId}\``,
    "",
    `**Resultado:** ${verdict}  `,
    `**Original:** \`${originalPath}\` · \`${before.planHash}\`  `,
    `**Tuned:** \`${tunedPath}\` · \`${after.planHash}\``,
    "",
    ...(rows.length > 0
      ? ["| Métrica | Original | Tuned | Delta |", "|---|---:|---:|---:|", ...rows]
      : ["_Os planos não possuem métricas diretamente comparáveis._"]),
    ...(comparison.resolvedHotspots.length > 0
      ? ["", `**Hotspots resolvidos:** ${comparison.resolvedHotspots.map((item) => `\`${item.code}\``).join(", ")}`]
      : []),
    ...(comparison.introducedHotspots.length > 0
      ? ["", `**Novos hotspots:** ${comparison.introducedHotspots.map((item) => `\`${item.code}\``).join(", ")}`]
      : []),
    "",
    "_Esta comparação avalia o plano, não prova equivalência semântica. Valide resultados e use análise observada antes de promover._",
  ].join("\n");
}

export function queryPlanEvidence(insight: QueryPlanInsight): string {
  return JSON.stringify(
    {
      mode: insight.mode,
      parser: insight.parser,
      planHash: insight.planHash,
      metrics: insight.metrics,
      hotspots: insight.hotspots.map(({ severity, code, operator, evidence }) => ({ severity, code, operator, evidence })),
      warnings: insight.warnings,
    },
    null,
    2
  );
}
