import assert from "node:assert/strict";
import { test } from "node:test";
import { findAntipatterns, renderFindings } from "../sql/antipatterns";
import { classifySql, normIdent } from "../sql/classify";
import { looksLikeDbtModel, stripJinja } from "../sql/jinja";
import { splitStatements, stripSqlNoise } from "../sql/lex";

// ---------- lex ----------

test("stripSqlNoise apaga comentários e strings preservando comprimento e linhas", () => {
  const sql = "SELECT a -- comentário com FROM tabela\nFROM t WHERE x = 'JOIN falso' /* WHERE */";
  const out = stripSqlNoise(sql);
  assert.equal(out.length, sql.length);
  assert.equal(out.split("\n").length, sql.split("\n").length);
  assert.ok(!out.includes("comentário"));
  assert.ok(!out.includes("JOIN falso"));
  assert.ok(out.includes("FROM t"));
});

test("stripSqlNoise: aspas escapadas '' e dollar-quoting não quebram o scanner", () => {
  const out = stripSqlNoise("SELECT 'it''s a FROM trap', $$JOIN dentro$$ FROM real_table");
  assert.ok(!out.includes("trap"));
  assert.ok(!out.includes("JOIN dentro"));
  assert.ok(out.includes("real_table"));
});

test("stripSqlNoise: identificador quotado com -- não vira comentário", () => {
  const out = stripSqlNoise('SELECT "a -- b" FROM t');
  assert.ok(out.includes('"a -- b"'));
  assert.ok(out.includes("FROM t"));
});

test("splitStatements divide no ; de nível zero e ignora ; em subquery de função", () => {
  const sql = stripSqlNoise("SELECT 1; SELECT 2;\n\nUPDATE t SET x = 1");
  const parts = splitStatements(sql);
  assert.equal(parts.length, 3);
  assert.equal(parts[2].line, 3);
});

// ---------- jinja ----------

test("stripJinja: ref/source viram identificadores reais e linhas são preservadas", () => {
  const sql = "{{ config(materialized='table') }}\nSELECT o.id\nFROM {{ ref('stg_orders') }} o\nJOIN {{ source('raw', 'customers') }} c ON c.id = o.customer_id";
  const r = stripJinja(sql);
  assert.ok(r.hadJinja);
  assert.equal(r.sql.split("\n").length, sql.split("\n").length);
  assert.ok(r.sql.includes("FROM stg_orders"));
  assert.ok(r.sql.includes("JOIN raw.customers"));
  assert.ok(!r.sql.includes("config"));
});

test("stripJinja: {% %} e {# #} somem; {{ this }} vira __this__; sem jinja é passthrough", () => {
  const r = stripJinja("{% if is_incremental() %}WHERE x > (SELECT max(x) FROM {{ this }}){% endif %}");
  assert.ok(r.sql.includes("FROM __this__"));
  assert.ok(!r.sql.includes("{%"));
  const plain = stripJinja("SELECT 1");
  assert.equal(plain.hadJinja, false);
});

test("looksLikeDbtModel: por caminho e por conteúdo", () => {
  assert.ok(looksLikeDbtModel("models/staging/stg_x.sql", "SELECT 1"));
  assert.ok(looksLikeDbtModel("qualquer.sql", "SELECT * FROM {{ ref('a') }}"));
  assert.ok(!looksLikeDbtModel("scripts/carga.sql", "SELECT 1"));
});

// ---------- classify ----------

test("classifySql: tipos, escrita e destrutivo", () => {
  const stmts = classifySql("SELECT 1; INSERT INTO t VALUES (1); DROP TABLE x; TRUNCATE TABLE y; UPDATE t SET a=1 WHERE id=2");
  assert.deepEqual(
    stmts.map((s) => s.kind),
    ["select", "insert", "drop", "truncate", "update"]
  );
  assert.deepEqual(
    stmts.map((s) => s.destructive),
    [false, false, true, true, false]
  );
  assert.equal(stmts[4].hasTopLevelWhere, true);
});

test("classifySql: tabelas de FROM/JOIN com alias e schema qualificado", () => {
  const [s] = classifySql('SELECT * FROM raw.orders o JOIN "Analytics".customers AS c ON c.id = o.customer_id');
  assert.deepEqual(s.tables, ["raw.orders", "analytics.customers"]);
  assert.equal(s.aliases.get("o"), "raw.orders");
  assert.equal(s.aliases.get("c"), "analytics.customers");
});

test("classifySql: CTEs não entram nas tabelas físicas; kind vem após o WITH", () => {
  const [s] = classifySql("WITH base AS (SELECT * FROM raw.orders), agg AS (SELECT * FROM base) SELECT * FROM agg");
  assert.equal(s.kind, "select");
  assert.deepEqual(s.ctes, ["base", "agg"]);
  assert.deepEqual(s.tables, ["raw.orders"]);
});

test("classifySql: FROM com vírgula lista as duas relações; subquery e função de tabela ficam de fora", () => {
  const [s] = classifySql("SELECT * FROM a, b WHERE a.id = b.id");
  assert.deepEqual(s.tables, ["a", "b"]);
  const [t] = classifySql("SELECT * FROM (SELECT 1) x JOIN generate_series(1, 10) g ON true");
  assert.deepEqual(t.tables, []);
});

test("normIdent: tira aspas e baixa caixa por partes", () => {
  assert.equal(normIdent('"Raw"."Orders"'), "raw.orders");
  assert.equal(normIdent("`db`.tabela"), "db.tabela");
});

// ---------- antipatterns ----------

function findRules(sql: string, opts: { isDbtModel?: boolean; hadJinja?: boolean } = {}): string[] {
  const stmts = classifySql(sql);
  return stmts.flatMap((s) => findAntipatterns(s, s.line, opts)).map((f) => f.rule);
}

test("anti-padrões de segurança: delete/update sem where e destrutivos", () => {
  assert.ok(findRules("DELETE FROM t").includes("delete-sem-where"));
  assert.ok(findRules("UPDATE t SET a = 1").includes("update-sem-where"));
  assert.ok(findRules("DROP TABLE t").includes("statement-destrutivo"));
  assert.ok(!findRules("DELETE FROM t WHERE id = 1").includes("delete-sem-where"));
});

test("select-star no topo e em subquery; EXISTS(SELECT *) é aceito", () => {
  assert.ok(findRules("SELECT * FROM t").includes("select-star"));
  assert.ok(findRules("SELECT a FROM (SELECT * FROM t) x").includes("select-star-em-subquery"));
  assert.ok(!findRules("SELECT a FROM t WHERE EXISTS (SELECT * FROM u WHERE u.id = t.id)").join(",").includes("select-star-em-subquery"));
  assert.ok(!findRules("SELECT COUNT(*) FROM t").includes("select-star"));
});

test("produto cartesiano (FROM a, b sem WHERE) é error; com WHERE vira join implícito", () => {
  const semWhere = classifySql("SELECT * FROM a, b").flatMap((s) => findAntipatterns(s, 1));
  assert.ok(semWhere.some((f) => f.rule === "produto-cartesiano" && f.severity === "error"));
  assert.ok(findRules("SELECT * FROM a, b WHERE a.id = b.id").includes("join-implicito"));
});

test("not-in-subquery, union-sem-all, like-curinga, cross-join", () => {
  assert.ok(findRules("SELECT a FROM t WHERE id NOT IN (SELECT id FROM u)").includes("not-in-subquery"));
  assert.ok(findRules("SELECT a FROM t UNION SELECT a FROM u").includes("union-sem-all"));
  assert.ok(!findRules("SELECT a FROM t UNION ALL SELECT a FROM u").includes("union-sem-all"));
  assert.ok(findRules("SELECT a FROM t WHERE nome LIKE '%silva'").includes("like-curinga-inicial"));
  assert.ok(findRules("SELECT * FROM datas CROSS JOIN produtos").includes("cross-join"));
});

test("order-by em subquery sem LIMIT é achado; com LIMIT e em OVER() não", () => {
  assert.ok(findRules("SELECT * FROM (SELECT a FROM t ORDER BY a) x").includes("order-by-em-subquery"));
  assert.ok(!findRules("SELECT * FROM (SELECT a FROM t ORDER BY a LIMIT 10) x").includes("order-by-em-subquery"));
  assert.ok(!findRules("SELECT ROW_NUMBER() OVER (PARTITION BY g ORDER BY a) FROM t").includes("order-by-em-subquery"));
  assert.ok(!findRules("SELECT ARRAY_AGG(a ORDER BY a) FROM t GROUP BY g").includes("order-by-em-subquery"));
});

test("funcao-em-filtro pega UPPER(col) = …; não dispara sobre literal", () => {
  assert.ok(findRules("SELECT a FROM t WHERE UPPER(nome) = 'X'").includes("funcao-em-filtro"));
  assert.ok(findRules("SELECT a FROM t WHERE DATE_TRUNC('day', criado_em) = '2026-01-01'").length > 0);
  assert.ok(!findRules("SELECT UPPER(nome) FROM t WHERE id = 1").includes("funcao-em-filtro"));
});

test("cte-nao-usada: definida e nunca referenciada; usada por outra CTE conta como uso", () => {
  assert.ok(findRules("WITH morta AS (SELECT 1) SELECT * FROM t").includes("cte-nao-usada"));
  assert.ok(!findRules("WITH a AS (SELECT 1), b AS (SELECT * FROM a) SELECT * FROM b").includes("cte-nao-usada"));
});

test("in-lista-grande dispara com 50+ itens; lista pequena e IN(SELECT) não", () => {
  const big = `SELECT a FROM t WHERE id IN (${Array.from({ length: 60 }, (_, i) => i).join(",")})`;
  assert.ok(findRules(big).includes("in-lista-grande"));
  assert.ok(!findRules("SELECT a FROM t WHERE id IN (1,2,3)").includes("in-lista-grande"));
  assert.ok(!findRules("SELECT a FROM t WHERE id IN (SELECT id FROM u)").includes("in-lista-grande"));
});

test("limit-em-modelo-dbt só no contexto dbt; insert-sem-colunas; janela-sem-partition", () => {
  assert.ok(findRules("SELECT a FROM t LIMIT 100", { isDbtModel: true }).includes("limit-em-modelo-dbt"));
  assert.ok(!findRules("SELECT a FROM t LIMIT 100").includes("limit-em-modelo-dbt"));
  assert.ok(findRules("INSERT INTO t VALUES (1, 2)").includes("insert-sem-colunas"));
  assert.ok(!findRules("INSERT INTO t (a, b) VALUES (1, 2)").includes("insert-sem-colunas"));
  assert.ok(findRules("SELECT SUM(x) OVER (ORDER BY d) FROM t").includes("janela-sem-partition"));
});

test("hadJinja degrada a confiança em um nível", () => {
  const stmts = classifySql("DELETE FROM t");
  const [comJinja] = findAntipatterns(stmts[0], 1, { hadJinja: true });
  assert.equal(comJinja.confidence, "média");
});

test("linhas dos achados apontam para a linha real do conteúdo", () => {
  const sql = "SELECT a\nFROM t\nWHERE nome LIKE '%x'";
  const stmts = classifySql(sql);
  const like = findAntipatterns(stmts[0], stmts[0].line).find((f) => f.rule === "like-curinga-inicial");
  assert.equal(like?.line, 3);
});

test("renderFindings: uma linha por achado com ícone/linha/regra/confiança", () => {
  const stmts = classifySql("DELETE FROM t");
  const txt = renderFindings(findAntipatterns(stmts[0], 1));
  assert.ok(txt.includes("✖ linha 1 [delete-sem-where] (confiança alta)"));
});

test("SQL de dbt real (jinja) analisa de ponta a ponta sem lançar", () => {
  const model = [
    "{{ config(materialized='incremental', unique_key='order_id') }}",
    "WITH pedidos AS (",
    "  SELECT * FROM {{ ref('stg_orders') }}",
    "  {% if is_incremental() %}",
    "  WHERE updated_at > (SELECT MAX(updated_at) FROM {{ this }})",
    "  {% endif %}",
    ")",
    "SELECT p.order_id, c.nome",
    "FROM pedidos p",
    "LEFT JOIN {{ source('raw', 'customers') }} c ON c.id = p.customer_id",
  ].join("\n");
  const r = stripJinja(model);
  const stmts = classifySql(r.sql);
  assert.equal(stmts.length, 1);
  assert.deepEqual(stmts[0].ctes, ["pedidos"]);
  assert.ok(stmts[0].tables.includes("raw.customers"));
  const findings = stmts.flatMap((s) => findAntipatterns(s, s.line, { isDbtModel: true, hadJinja: r.hadJinja }));
  assert.ok(findings.some((f) => f.rule === "select-star-em-subquery" || f.rule === "select-star"));
});
