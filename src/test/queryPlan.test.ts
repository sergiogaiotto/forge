import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareQueryPlans,
  parseQueryPlan,
  queryPlanEvidence,
  renderQueryPlanCockpit,
  renderQueryPlanComparison,
} from "../warehouse/queryPlan";

test("Postgres JSON: extrai custo, cardinalidade, buffers e hotspots observados", () => {
  const raw = [
    "QUERY PLAN",
    JSON.stringify([
      {
        Plan: {
          "Node Type": "Nested Loop",
          "Startup Cost": 0.4,
          "Total Cost": 9000,
          "Plan Rows": 10,
          "Actual Rows": 4000,
          "Actual Loops": 100,
          "Shared Hit Blocks": 50,
          "Shared Read Blocks": 120,
          Plans: [
            {
              "Node Type": "Seq Scan",
              "Relation Name": "orders",
              "Plan Rows": 20000,
              "Actual Rows": 2000000,
              "Actual Loops": 1,
              "Rows Removed by Filter": 3000000,
              "Temp Written Blocks": 25,
            },
          ],
        },
        "Planning Time": 2.5,
        "Execution Time": 812.3,
      },
    ]),
  ].join("\n");
  const plan = parseQueryPlan("postgres", raw, "observed");
  assert.equal(plan.parser, "postgres-json");
  assert.equal(plan.metrics.optimizerCost, 9000);
  assert.equal(plan.metrics.executionTimeMs, 812.3);
  assert.equal(plan.metrics.sharedReadBlocks, 120);
  assert.ok(plan.hotspots.some((item) => item.code === "nested-loop-volume"));
  assert.ok(plan.hotspots.some((item) => item.code === "sequential-scan"));
  assert.ok(plan.hotspots.some((item) => item.code === "cardinality-error"));
  assert.ok(plan.hotspots.some((item) => item.code === "temp-spill"));
});

test("Postgres JSON em CSV do psql continua parseável", () => {
  const json = JSON.stringify([{ Plan: { "Node Type": "Index Scan", "Total Cost": 15.2, "Plan Rows": 20 } }]);
  const raw = `QUERY PLAN\n"${json.replace(/"/g, '""')}"`;
  const plan = parseQueryPlan("postgres", raw);
  assert.equal(plan.metrics.optimizerCost, 15.2);
  assert.equal(plan.operators[0]?.name, "Index Scan");
});

test("Oracle DBMS_XPLAN: custo, linhas, full scan e partition all", () => {
  const raw = [
    "Plan hash value: 123",
    "| Id | Operation            | Name   | Rows | Bytes | Cost (%CPU)| Time     |",
    "|  0 | SELECT STATEMENT     |        | 1000 | 10000 | 450 (2)    | 00:00:03 |",
    "|  1 | PARTITION RANGE ALL  |        | 1000 | 10000 | 440 (2)    | 00:00:03 |",
    "|  2 | TABLE ACCESS FULL    | ORDERS | 1000000 | 9M | 440 (2) | 00:00:03 |",
  ].join("\n");
  const plan = parseQueryPlan("oracle", raw);
  assert.equal(plan.parser, "oracle-text");
  assert.equal(plan.metrics.optimizerCost, 450);
  assert.equal(plan.metrics.estimatedRows, 1000);
  assert.ok(plan.hotspots.some((item) => item.code === "full-table-scan"));
  assert.ok(plan.hotspots.some((item) => item.code === "partition-scan-all"));
  assert.match(plan.warnings[0], /unidade relativa/);
});

test("BigQuery dry-run: bytes processados e scan grande", () => {
  const raw = JSON.stringify({ statistics: { query: { totalBytesProcessed: String(2 * 1024 ** 4), totalBytesBilled: String(2 * 1024 ** 4) } } });
  const plan = parseQueryPlan("bigquery", raw);
  assert.equal(plan.parser, "bigquery-json");
  assert.equal(plan.metrics.bytesProcessed, 2 * 1024 ** 4);
  assert.ok(plan.hotspots.some((item) => item.code === "large-scan" && item.severity === "high"));
});

test("BigQuery histórico em CSV: lê bytes, slots e duração observada", () => {
  const raw = [
    "totalBytesProcessed,totalBytesBilled,totalSlotMs,executionTimeMs",
    "1099511627776,1099511627776,45000,3210",
  ].join("\n");
  const plan = parseQueryPlan("bigquery", raw, "observed");
  assert.equal(plan.metrics.bytesProcessed, 1024 ** 4);
  assert.equal(plan.metrics.slotMs, 45000);
  assert.equal(plan.metrics.executionTimeMs, 3210);
  assert.match(plan.warnings.join(" "), /último job equivalente/);
});

test("DuckDB JSON: operadores e cross product", () => {
  const json = JSON.stringify([
    {
      name: "CROSS_PRODUCT",
      extra_info: { "Estimated Cardinality": "200000" },
      children: [{ name: "SEQ_SCAN", extra_info: { "Estimated Cardinality": "1000000" }, children: [] }],
    },
  ]);
  const raw = `explain_key,explain_value\nphysical_plan,"${json.replace(/"/g, '""')}"`;
  const plan = parseQueryPlan("duckdb", raw);
  assert.equal(plan.parser, "duckdb-json");
  assert.equal(plan.operators.length, 2);
  assert.ok(plan.hotspots.some((item) => item.code === "cartesian-join"));
  assert.ok(plan.hotspots.some((item) => item.code === "sequential-scan"));
});

test("comparação A/B calcula deltas e hotspots resolvidos", () => {
  const before = parseQueryPlan(
    "postgres",
    JSON.stringify([{ Plan: { "Node Type": "Seq Scan", "Total Cost": 1000, "Plan Rows": 500000 } }])
  );
  const after = parseQueryPlan(
    "postgres",
    JSON.stringify([{ Plan: { "Node Type": "Index Scan", "Total Cost": 200, "Plan Rows": 1000 } }])
  );
  const comparison = compareQueryPlans(before, after);
  assert.equal(comparison.verdict, "improvement");
  assert.equal(comparison.metrics[0]?.deltaPct, -80);
  assert.ok(comparison.resolvedHotspots.some((item) => item.code === "sequential-scan"));
  const card = renderQueryPlanComparison("pg", "q.sql", "q.tuned.sql", before, after);
  assert.match(card, /melhoria estimada/);
  assert.match(card, /-80%/);
});

test("cockpit e evidência usam métricas estruturadas e limitam plano bruto", () => {
  const raw = JSON.stringify([{ Plan: { "Node Type": "Index Scan", "Total Cost": 20, "Plan Rows": 10 } }]);
  const plan = parseQueryPlan("postgres", raw);
  const card = renderQueryPlanCockpit("pg", plan, raw, { command: "psql explain.sql", durationMs: 120 });
  assert.match(card, /Query Cost Cockpit/);
  assert.match(card, /Custo do otimizador/);
  assert.match(card, /Plano bruto/);
  const evidence = queryPlanEvidence(plan);
  assert.match(evidence, /"optimizerCost": 20/);
  assert.ok(!evidence.includes(raw), "o prompt recebe evidência normalizada, não duplica o plano bruto");
});
