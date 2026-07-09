import assert from "node:assert/strict";
import { test } from "node:test";
import { levenshtein, parseDbtArtifacts, renderImpactCard, renderSchemaContext } from "../dbt/artifacts";
import { parseTargetPath } from "../dbt/loader";
import { classifySql } from "../sql/classify";
import { analyzeSqlProposal, sqlEvidenceForReview } from "../sql/engine";
import { renderLineage, selectLineage } from "../sql/lineage";
import { checkAgainstSchema } from "../sql/schemaCheck";

// Manifest/catalog mínimos no formato real do dbt (subconjunto que o parser usa).
const MANIFEST = {
  metadata: { generated_at: "2026-07-08T12:00:00Z" },
  nodes: {
    "model.shop.stg_orders": {
      resource_type: "model",
      name: "stg_orders",
      schema: "staging",
      database: "analytics",
      original_file_path: "models/staging/stg_orders.sql",
      config: { materialized: "view" },
      columns: { order_id: { description: "PK" }, customer_id: {}, valor_total: {}, updated_at: {} },
      depends_on: { nodes: ["source.shop.raw.orders"] },
    },
    "model.shop.fct_pedidos": {
      resource_type: "model",
      name: "fct_pedidos",
      schema: "marts",
      original_file_path: "models/marts/fct_pedidos.sql",
      config: { materialized: "incremental" },
      columns: { order_id: {}, receita: {} },
    },
    "test.shop.unique_stg_orders_order_id": { resource_type: "test", name: "unique_stg_orders_order_id" },
  },
  sources: {
    "source.shop.raw.orders": {
      resource_type: "source",
      name: "orders",
      identifier: "orders",
      source_name: "raw",
      schema: "raw",
      columns: { id: {}, customer_id: {}, amount: {} },
    },
  },
  exposures: { "exposure.shop.dash_vendas": { name: "dash_vendas" } },
  child_map: {
    "model.shop.stg_orders": ["model.shop.fct_pedidos", "test.shop.unique_stg_orders_order_id"],
    "model.shop.fct_pedidos": ["exposure.shop.dash_vendas"],
  },
  parent_map: {
    "model.shop.stg_orders": ["source.shop.raw.orders"],
    "model.shop.fct_pedidos": ["model.shop.stg_orders"],
  },
};

const CATALOG = {
  nodes: {
    "model.shop.stg_orders": {
      columns: {
        ORDER_ID: { type: "NUMBER", index: 1 },
        CUSTOMER_ID: { type: "NUMBER", index: 2 },
        VALOR_TOTAL: { type: "FLOAT", index: 3 },
        UPDATED_AT: { type: "TIMESTAMP_NTZ", index: 4 },
      },
    },
  },
};

test("parseDbtArtifacts: modelos, sources, lookups e colunas do catalog (tipos reais)", () => {
  const idx = parseDbtArtifacts(MANIFEST, CATALOG);
  assert.equal(idx.size(), 3); // 2 models + 1 source
  assert.ok(idx.findTable("stg_orders"));
  assert.ok(idx.findTable("staging.stg_orders"));
  assert.ok(idx.findTable("analytics.staging.stg_orders"));
  assert.ok(idx.findTable("raw.orders"));
  const stg = idx.findTable("stg_orders")!;
  assert.equal(stg.columns.find((c) => c.name === "order_id")?.type, "NUMBER");
  assert.equal(stg.materialized, "view");
  assert.ok(idx.findByPath("models/staging/stg_orders.sql"));
  assert.ok(idx.findByPath("transform/models/staging/stg_orders.sql"), "tolera prefixo de subdiretório");
});

test("downstream/upstream: raio de explosão via child_map", () => {
  const idx = parseDbtArtifacts(MANIFEST);
  const down = idx.downstream("model.shop.stg_orders");
  assert.deepEqual(down.direct.map((n) => n.name), ["fct_pedidos"]);
  assert.equal(down.tests, 1);
  assert.deepEqual(down.exposures, ["dash_vendas"]);
  assert.equal(down.maxDepth, 1);
  const up = idx.upstreamDirect("model.shop.fct_pedidos");
  assert.deepEqual(up.map((n) => n.name), ["stg_orders"]);
});

test("suggestTable/levenshtein: erro de digitação encontra o vizinho", () => {
  const idx = parseDbtArtifacts(MANIFEST);
  assert.equal(idx.suggestTable("stg_order"), "stg_orders");
  assert.equal(idx.suggestTable("fct_pedido"), "fct_pedidos");
  assert.equal(levenshtein("abc", "abd", 3), 1);
  assert.equal(levenshtein("abc", "xyzq", 2), undefined);
});

test("checkAgainstSchema: tabela fantasma e coluna fantasma com sugestão; CTE não é tabela", () => {
  const idx = parseDbtArtifacts(MANIFEST, CATALOG);
  const stmts = classifySql("WITH base AS (SELECT * FROM stg_orders) SELECT o.order_idd FROM fct_pedidoss o JOIN base b ON b.order_id = o.order_id");
  const findings = checkAgainstSchema(stmts, idx, (s) => s.line);
  const rules = findings.map((f) => f.rule);
  assert.ok(rules.includes("tabela-desconhecida"));
  assert.ok(findings.some((f) => f.message.includes("fct_pedidos")), "sugere o nome certo");
  // coluna o.order_idd não é checada porque a tabela do alias é desconhecida (sem opinião dupla)
  const ok = checkAgainstSchema(classifySql("SELECT s.order_idd FROM stg_orders s"), idx, (s) => s.line);
  assert.ok(ok.some((f) => f.rule === "coluna-desconhecida" && f.message.includes("order_id")));
});

test("renderSchemaContext: top-K por relevância lexical; vazio quando nada casa", () => {
  const idx = parseDbtArtifacts(MANIFEST, CATALOG);
  const ctx = renderSchemaContext(idx, "crie um modelo que soma valor_total por customer_id dos pedidos (stg_orders)");
  assert.ok(ctx.includes("staging.stg_orders"));
  assert.ok(ctx.includes("valor_total FLOAT"));
  assert.equal(renderSchemaContext(idx, "xyzabc qwerty"), "");
});

test("renderImpactCard: tabela com downstream e nota de frescor", () => {
  const idx = parseDbtArtifacts(MANIFEST);
  const card = renderImpactCard(idx, idx.findModelByName("stg_orders")!);
  assert.ok(card.includes("Raio de explosão"));
  assert.ok(card.includes("fct_pedidos"));
  assert.ok(card.includes("Testes impactados | 1"));
  assert.ok(card.includes("dash_vendas"));
  assert.ok(card.includes("2026-07-08"));
  const local = renderImpactCard(idx, idx.findModelByName("fct_pedidos")!);
  assert.ok(!local.includes("| Downstream direto | 0")); // exposure-only ainda mostra tabela
});

test("parseTargetPath: default e customizado", () => {
  assert.equal(parseTargetPath("name: shop\nprofile: shop"), "target");
  assert.equal(parseTargetPath('name: shop\ntarget-path: "build/dbt"'), "build/dbt");
});

// ---------- engine (ValidatorResults) ----------

test("analyzeSqlProposal: segurança vira gate no modo conservative; advisory nunca bloqueia", () => {
  const results = analyzeSqlProposal("scripts/limpeza.sql", "DELETE FROM staging.stg_orders", { mode: "conservative" });
  const seg = results.find((r) => r.id === "sql:seguranca");
  assert.equal(seg?.status, "failed");
  assert.equal(seg?.gate, true);
  const adv = analyzeSqlProposal("scripts/limpeza.sql", "DELETE FROM staging.stg_orders", { mode: "advisory" });
  assert.equal(adv.find((r) => r.id === "sql:seguranca")?.gate, false);
  assert.deepEqual(analyzeSqlProposal("scripts/limpeza.sql", "DELETE FROM t", { mode: "off" }), []);
  assert.deepEqual(analyzeSqlProposal("app/main.py", "print(1)", { mode: "conservative" }), []);
});

test("analyzeSqlProposal: modelo dbt limpo com manifest → schema ok; sem manifest → skipped com dica", () => {
  const idx = parseDbtArtifacts(MANIFEST, CATALOG);
  const model = "SELECT s.order_id, s.valor_total FROM {{ ref('stg_orders') }} s WHERE s.order_id IS NOT NULL";
  const withIdx = analyzeSqlProposal("models/marts/novo.sql", model, { mode: "conservative", index: idx });
  assert.equal(withIdx.find((r) => r.id === "sql:schema")?.status, "ok");
  assert.equal(withIdx.find((r) => r.id === "sql:antipadroes")?.status, "ok");
  const noIdx = analyzeSqlProposal("models/marts/novo.sql", model, { mode: "conservative" });
  const skipped = noIdx.find((r) => r.id === "sql:schema");
  assert.equal(skipped?.status, "skipped");
  assert.ok(skipped?.reason?.includes("dbt parse"));
});

test("analyzeSqlProposal: tabela alucinada aparece no sql:schema com sugestão", () => {
  const idx = parseDbtArtifacts(MANIFEST, CATALOG);
  const res = analyzeSqlProposal("models/marts/x.sql", "SELECT * FROM stg_ordersz", { mode: "conservative", index: idx });
  const schema = res.find((r) => r.id === "sql:schema");
  assert.equal(schema?.status, "failed");
  assert.equal(schema?.gate, false);
  assert.ok(schema?.output.includes("stg_orders"));
});

test("sqlEvidenceForReview: junta anti-padrões e schema para a lente do revisor", () => {
  const idx = parseDbtArtifacts(MANIFEST, CATALOG);
  const ev = sqlEvidenceForReview("models/marts/x.sql", "SELECT * FROM stg_ordersz LIMIT 10", { mode: "advisory", index: idx });
  const rules = ev.map((f) => f.rule);
  assert.ok(rules.includes("select-star"));
  assert.ok(rules.includes("limit-em-modelo-dbt"));
  assert.ok(rules.includes("tabela-desconhecida"));
});

// ---------- lineage ----------

test("selectLineage: direto, expressão e alias — caso simples", () => {
  const [stmt] = classifySql("SELECT o.order_id, o.valor_total * 0.9 AS receita_liquida FROM stg_orders o");
  const lin = selectLineage(stmt);
  assert.equal(lin.confidence, "alta");
  const byName = Object.fromEntries(lin.columns.map((c) => [c.output, c]));
  assert.deepEqual(byName.order_id.sources, ["stg_orders.order_id"]);
  assert.equal(byName.order_id.transform, "direta");
  assert.deepEqual(byName.receita_liquida.sources, ["stg_orders.valor_total"]);
  assert.equal(byName.receita_liquida.transform, "expressao");
});

test("selectLineage: atravessa CTE até a tabela física", () => {
  const [stmt] = classifySql(
    "WITH base AS (SELECT o.order_id, o.valor_total FROM stg_orders o) SELECT b.order_id, SUM(b.valor_total) AS receita FROM base b GROUP BY 1"
  );
  const lin = selectLineage(stmt);
  const byName = Object.fromEntries(lin.columns.map((c) => [c.output, c]));
  assert.deepEqual(byName.order_id.sources, ["stg_orders.order_id"]);
  assert.deepEqual(byName.receita.sources, ["stg_orders.valor_total"]);
  assert.equal(lin.confidence, "média");
});

test("selectLineage: coluna sem qualificador com 2 tabelas vira origem ambígua '?'", () => {
  const [stmt] = classifySql("SELECT nome FROM clientes c JOIN pedidos p ON p.cliente_id = c.id");
  const lin = selectLineage(stmt);
  assert.deepEqual(lin.columns[0].sources, ["?.nome"]);
});

test("selectLineage: star marca lineage incompleto; renderLineage produz tabela", () => {
  const [stmt] = classifySql("SELECT * FROM stg_orders");
  const lin = selectLineage(stmt);
  assert.equal(lin.star, true);
  const [stmt2] = classifySql("SELECT o.order_id FROM stg_orders o");
  const txt = renderLineage(selectLineage(stmt2));
  assert.ok(txt.includes("| `order_id` | direta | stg_orders.order_id |"));
});
