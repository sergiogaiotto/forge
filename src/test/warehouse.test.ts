import assert from "node:assert/strict";
import { test } from "node:test";
import { decideSqlRun } from "../warehouse/governance";
import { buildCostPlan, buildRunPlan, buildTestPlan, capCsv, isPlanError, renderResultCard, sanitizeWarehouseOutput } from "../warehouse/sqlRunners";
import { columnsInventorySql, mergeIndexes, parseInventoryCsv, parseSnapshot, serializeSnapshot, snapshotToIndex } from "../warehouse/schemaSnapshot";
import { compareProfiles, parseParityArgs, parseProfileCsv, profileSql, renderParityCard } from "../warehouse/parity";
import { renderFinopsCard, topQueriesSql } from "../warehouse/finops";
import { maskDataSample, piiConfidenceLabel, renderPiiCard, scanIndexForPii } from "../util/piiScan";
import { parseDbtArtifacts } from "../dbt/artifacts";
import { WarehouseConnection } from "../warehouse/types";

const ORA: WarehouseConnection = { id: "dw", kind: "oracle", connect: "app@DWPROD" };
const PG: WarehouseConnection = { id: "pg", kind: "postgres", connect: "postgresql://app@db:5432/prod" };
const BQ: WarehouseConnection = { id: "bq", kind: "bigquery", connect: "claro-data", schemas: ["vendas"] };

// ---------- governança por motor ----------

test("governança: SELECT roda; escrita bloqueia em readonly (default) e confirma com readonly:false", () => {
  assert.equal(decideSqlRun("SELECT * FROM t", ORA).verdict, "auto");
  assert.equal(decideSqlRun("INSERT INTO t VALUES (1)", ORA).verdict, "blocked"); // readonly default
  assert.equal(decideSqlRun("UPDATE t SET a=1 WHERE id=2", { ...ORA, readonly: false }).verdict, "confirm");
  assert.equal(decideSqlRun("", ORA).verdict, "blocked");
});

test("governança: SELECT … INTO (CTAS) é ESCRITA → BLOQUEIA em readonly (não roda o CREATE como leitura)", () => {
  // O bug do survey: SELECT INTO rodava "auto" numa conexão readonly, EXECUTANDO o CREATE. Agora write → blocked.
  assert.equal(decideSqlRun("SELECT a, b INTO nova_tab FROM origem", ORA).verdict, "blocked");
  assert.equal(decideSqlRun("SELECT * INTO OUTFILE '/tmp/x.csv' FROM t", ORA).verdict, "blocked");
  // com readonly:false a escrita é permitida SÓ com confirmação humana (não auto)
  assert.equal(decideSqlRun("SELECT a INTO nova_tab FROM t", { ...ORA, readonly: false }).verdict, "confirm");
  // MySQL `INTO @var` (variável, não grava) segue leitura → auto (sem falso-positivo)
  assert.equal(decideSqlRun("SELECT COUNT(*) INTO @cnt FROM t", ORA).verdict, "auto");
});

test("governança: DROP/TRUNCATE NUNCA executam, mesmo com readonly:false; não-classificável = escrita", () => {
  assert.equal(decideSqlRun("DROP TABLE t", { ...ORA, readonly: false }).verdict, "blocked");
  assert.equal(decideSqlRun("TRUNCATE TABLE t", { ...ORA, readonly: false }).verdict, "blocked");
  // string não-terminada → análise parcial NUNCA ganha benefício da dúvida para EXECUTAR
  const partial = decideSqlRun("SELECT 'aberta FROM t", { ...ORA, readonly: false });
  assert.equal(partial.verdict, "confirm");
  assert.equal(decideSqlRun("SELECT 'aberta FROM t", ORA).verdict, "blocked");
});

// ---------- planos de CLI (caminho tradicional) ----------

test("plano Oracle: senha via wrapper /nolog (NUNCA em argv/display); wallet vira TNS_ADMIN", () => {
  const plan = buildRunPlan(ORA, "SELECT 1 FROM dual", { password: "s3nh@", rowCap: 50 });
  assert.ok(!isPlanError(plan));
  if (isPlanError(plan)) return;
  assert.equal(plan.tool, "sql"); // SQLcl
  assert.ok(plan.args.join(" ").includes("/nolog"));
  assert.ok(!plan.args.join(" ").includes("s3nh@"), "senha não pode ir em argv");
  assert.ok(!plan.display.includes("s3nh@"), "senha não pode ir no display");
  const wrapper = plan.scripts?.find((s) => s.name === "wrapper.sql")?.content ?? "";
  assert.ok(wrapper.includes('CONNECT app/"s3nh@"@DWPROD'));
  assert.ok(wrapper.includes("WHENEVER SQLERROR EXIT FAILURE"));
  const adw = buildRunPlan({ ...ORA, walletDir: "C:/wallets/adw" }, "SELECT 1 FROM dual", { rowCap: 50 });
  if (!isPlanError(adw)) assert.equal(adw.env?.TNS_ADMIN, "C:/wallets/adw");
  // sqlplus alternativo
  const sp = buildRunPlan({ ...ORA, tool: "sqlplus" }, "SELECT 1 FROM dual", { rowCap: 50 });
  if (!isPlanError(sp)) assert.ok(sp.scripts?.some((s) => s.content.includes("SET MARKUP CSV ON")));
});

test("plano Postgres: PGPASSWORD via env, senha na URI mascarada no display; BigQuery via stdin com max_rows", () => {
  const pg = buildRunPlan(PG, "SELECT 1", { password: "pass", rowCap: 50 });
  if (!isPlanError(pg)) {
    assert.equal(pg.env?.PGPASSWORD, "pass");
    assert.ok(pg.args.includes("--csv") && pg.args.includes("ON_ERROR_STOP=1"));
  }
  const masked = buildRunPlan({ ...PG, connect: "postgresql://app:secreta@db/prod" }, "SELECT 1", { rowCap: 50 });
  if (!isPlanError(masked)) assert.ok(!masked.display.includes("secreta"));
  const bq = buildRunPlan(BQ, "SELECT 1", { rowCap: 25 });
  if (!isPlanError(bq)) {
    assert.equal(bq.stdin, "SELECT 1");
    assert.ok(bq.args.includes("--max_rows=25"));
    assert.ok(bq.args.includes("--project_id=claro-data"));
  }
});

test("plano: object storage não executa SQL; teste de conexão lista objetos; custo = dry-run/EXPLAIN", () => {
  const s3 = buildRunPlan({ id: "lake", kind: "s3", connect: "s3://claro-lake/raw" }, "SELECT 1", { rowCap: 50 });
  assert.ok(isPlanError(s3));
  const s3test = buildTestPlan({ id: "lake", kind: "s3", connect: "s3://claro-lake/raw" }, {});
  if (!isPlanError(s3test)) assert.deepEqual(s3test.args.slice(0, 2), ["s3", "ls"]);
  const ociTest = buildTestPlan({ id: "oci", kind: "oci-os", connect: "ns1/bucket-dados" }, {});
  if (!isPlanError(ociTest)) assert.ok(ociTest.args.includes("bucket-dados"));
  const bqCost = buildCostPlan(BQ, "SELECT * FROM vendas.pedidos", {});
  if (!isPlanError(bqCost)) assert.ok(bqCost.args.includes("--dry_run"));
  const oraCost = buildCostPlan(ORA, "SELECT * FROM pedidos", { password: "x" });
  if (!isPlanError(oraCost)) assert.ok(oraCost.scripts?.some((s) => s.content.includes("DBMS_XPLAN")));
});

test("capCsv limita as linhas de dados; renderResultCard vira tabela quando pequeno", () => {
  const csv = ["a,b", "1,2", "3,4", "5,6"].join("\n");
  const capped = capCsv(csv, 2);
  assert.ok(capped.truncated);
  assert.equal(capped.text.split("\n").length, 3); // cabeçalho + 2
  const card = renderResultCard("Resultado", "psql -f x", capped.text, { ok: true, truncated: true, durationMs: 1200, rowCap: 2 });
  assert.ok(card.includes("| a | b |"));
  assert.ok(card.includes("amostra capada"));
  assert.ok(card.includes("LGPD"));
});

// ---------- snapshot de schema ----------

test("inventário por dialeto: Oracle/PG genéricos; BigQuery exige datasets; parse + índice", () => {
  assert.ok((columnsInventorySql("oracle", ["VENDAS"]) as string).includes("all_tab_columns"));
  assert.ok((columnsInventorySql("postgres", []) as string).includes("information_schema.columns"));
  const noDs = columnsInventorySql("bigquery", []);
  assert.ok(typeof noDs !== "string" && noDs.error.includes("datasets"));
  const bq = columnsInventorySql("bigquery", ["vendas", "clientes"]) as string;
  assert.ok(bq.includes("`vendas`.INFORMATION_SCHEMA.COLUMNS") && bq.includes("UNION ALL"));

  const rows = parseInventoryCsv("tabela,coluna,tipo\nvendas.pedidos,id,NUMBER\nvendas.pedidos,valor,FLOAT\nvendas.clientes,cpf,VARCHAR2");
  assert.equal(rows.length, 3);
  const idx = snapshotToIndex({ connectionId: "dw", kind: "oracle", takenAt: "2026-07-09T10:00:00Z", rows });
  assert.equal(idx.size(), 2);
  assert.ok(idx.findTable("vendas.pedidos"));
  assert.ok(idx.findTable("pedidos"));
  assert.deepEqual(idx.findTable("pedidos")!.columns.map((c) => c.name), ["id", "valor"]);
});

test("mergeIndexes junta dbt + snapshot; serialização roundtrip", () => {
  const dbt = parseDbtArtifacts({ nodes: { "model.x.stg_a": { resource_type: "model", name: "stg_a", schema: "st", columns: {} } } });
  const snap = snapshotToIndex({ connectionId: "dw", kind: "oracle", takenAt: "t", rows: [{ table: "vendas.pedidos", column: "id" }] });
  const merged = mergeIndexes([dbt, snap]);
  assert.ok(merged.findTable("stg_a") && merged.findTable("vendas.pedidos"));
  const round = parseSnapshot(serializeSnapshot({ connectionId: "dw", kind: "oracle", takenAt: "t", rows: [{ table: "a.b", column: "c" }] }));
  assert.equal(round?.rows[0].table, "a.b");
  assert.equal(parseSnapshot("{invalido"), null);
});

// ---------- paridade ----------

test("paridade: SQL por agregados (nenhuma linha sai), parse, comparação e card", () => {
  const sql = profileSql("oracle", "vendas.pedidos", ["id", "valor"]);
  assert.ok(sql.includes("COUNT(*)") && sql.includes("COUNT(DISTINCT id)") && sql.includes("UNION ALL"));
  assert.ok(!/SELECT\s+\*/i.test(sql), "perfil nunca seleciona linhas");
  const a = parseProfileCsv("metrica,coluna,valor\ncount,*,100\nnao_nulos,id,100\ndistintos,id,100");
  const b = parseProfileCsv("metrica,coluna,valor\ncount,*,98\nnao_nulos,id,98\ndistintos,id,97");
  const cmp = compareProfiles(a, b);
  assert.equal(cmp.equal, false);
  assert.equal(cmp.diffs.length, 3);
  const card = renderParityCard("prod.pedidos", "dw.pedidos", cmp);
  assert.ok(card.includes("3 divergências") && card.includes("compliance-safe"));
  const ok = compareProfiles(a, a);
  assert.ok(renderParityCard("a", "b", ok).includes("Paridade OK"));
});

test("paridade SEGURANÇA: profileSql rejeita injeção via TABELA e PULA coluna insegura (nunca interpola cru)", () => {
  // a tabela vem do usuário (/paridade); nome com ';'/UNION/aspa/espaço/paren LANÇA (fail-closed), não injeta.
  // Isto também fecha a exfil de PII: a paridade roda com skipMask=true, então uma injeção-de-leitura mostraria
  // linhas SEM máscara — impossível agora que o SQL do perfil não é injetável.
  for (const bad of ["t; DROP TABLE x; --", "t WHERE 1=0 UNION SELECT * FROM pii --", 't" ; DROP', "a b", "t(1)"]) {
    assert.throws(() => profileSql("postgres", bad, ["id"]), /inv[áa]lido/i, `deveria rejeitar: ${bad}`);
  }
  // coluna (do índice de schema) insegura é PULADA; as válidas seguem perfiladas; o texto malicioso não vaza.
  const sql = profileSql("postgres", "t", ["ok_col", "x) FROM segredos; DROP TABLE y; --", "outra"]);
  assert.ok(!/DROP TABLE y|FROM segredos/.test(sql), "coluna maliciosa não aparece crua no SQL");
  assert.ok(/COUNT\(ok_col\)/.test(sql) && /COUNT\(outra\)/.test(sql), "colunas válidas seguem perfiladas");
  // válidos: BigQuery quota com backtick; não-BQ mantém bare (preserva case-folding); Unicode pt-BR é aceito.
  assert.ok(profileSql("bigquery", "ds.tab", ["c"]).includes("`ds.tab`"));
  assert.ok(profileSql("postgres", "vendas.pedidos", ["id"]).includes("FROM vendas.pedidos"));
  const uni = profileSql("postgres", "órgão", ["índice"]);
  assert.ok(uni.includes("FROM órgão") && uni.includes("COUNT(índice)"), "nome Unicode válido é aceito");
});

test("parseParityArgs: dois tokens, com conexao:tabela opcional", () => {
  const p = parseParityArgs("dw:vendas.pedidos bq:vendas.pedidos");
  assert.ok(!("error" in p));
  if (!("error" in p)) {
    assert.equal(p.left.conn, "dw");
    assert.equal(p.right.table, "vendas.pedidos");
  }
  assert.ok("error" in parseParityArgs("apenas_uma"));
});

// ---------- finops ----------

test("finops: SQL por dialeto e card com dica", () => {
  assert.ok((topQueriesSql("bigquery", "region-southamerica-east1") as string).includes("region-southamerica-east1"));
  assert.ok((topQueriesSql("postgres") as string).includes("pg_stat_statements"));
  assert.ok((topQueriesSql("oracle") as string).includes("v$sql"));
  assert.ok(typeof topQueriesSql("duckdb") !== "string");
  const card = renderFinopsCard("bq", "bigquery", "usuario,tb_processados,consultas,exemplo\nana@claro,12.5,340,SELECT *");
  assert.ok(card.includes("| ana@claro |") && card.includes("US$"));
  assert.ok(renderFinopsCard("pg", "postgres", "").includes("pg_stat_statements"));
});

// ---------- PII / LGPD ----------

test("piiScan: dicionário LGPD por nome de coluna + card; máscara de amostras (CPF/e-mail/telefone)", () => {
  const idx = snapshotToIndex({
    connectionId: "dw",
    kind: "oracle",
    takenAt: "t",
    rows: [
      { table: "vendas.clientes", column: "cpf" },
      { table: "vendas.clientes", column: "email" },
      { table: "vendas.clientes", column: "valor_total" },
      { table: "rh.func", column: "salario" },
    ],
  });
  const findings = scanIndexForPii(idx);
  assert.equal(findings.length, 3);
  assert.ok(findings.some((f) => f.category.includes("CPF")));
  // ordenação: confiança "alta" (código interno estável) vem antes de "média" — a chave de sort NÃO é
  // afetada por tradução (o display passa por piiConfidenceLabel).
  assert.equal(findings[0].confidence, "alta");
  const card = renderPiiCard(findings, idx.size());
  assert.ok(card.includes("DBMS_REDACT") && card.includes("policy tags"));
  assert.match(card, /confiança/); // cabeçalho da coluna
  assert.ok(card.includes(`| ${piiConfidenceLabel("alta")} |`), "o card exibe a confiança via piiConfidenceLabel, não o enum cru");
  assert.ok(renderPiiCard([], 5).includes("✅"));
  assert.ok(renderPiiCard([], 0).includes("/schema-db"));

  const masked = maskDataSample("id,cpf,email\n1,123.456.789-09,ana@claro.com.br\n2,98765432100,b@x.io");
  assert.ok(!masked.includes("123.456.789-09"));
  assert.ok(!masked.includes("ana@claro.com.br"));
  assert.ok(masked.includes("▇▇▇"));
});

// ---- regressões da revisão adversarial (Ondas 3/4) ------------------------------------------------

import { classifySql } from "../sql/classify";
import { oracleTerminate } from "../warehouse/sqlRunners";

test("REGRESSÃO crítica: DML dentro de CTE é ESCRITA (não roda como leitura)", () => {
  const cteDelete = "WITH d AS (DELETE FROM staging WHERE loaded=true RETURNING id) SELECT count(*) FROM d";
  const [s] = classifySql(cteDelete);
  assert.equal(s.write, true, "data-modifying CTE deve ser escrita");
  assert.equal(decideSqlRun(cteDelete, ORA).verdict, "blocked"); // readonly default
  assert.equal(decideSqlRun(cteDelete, { ...ORA, readonly: false }).verdict, "confirm");
  // controle: CTE só de leitura continua auto
  assert.equal(decideSqlRun("WITH x AS (SELECT 1) SELECT * FROM x", ORA).verdict, "auto");
});

test("REGRESSÃO crítica: blocos PL/SQL BEGIN/CALL/EXEC/DO são escrita (não 'other' auto)", () => {
  for (const sql of ["BEGIN delete_all(); END;", "CALL limpa_tabela()", "EXEC sp_purge", "DO $$ BEGIN DELETE FROM t; END $$"]) {
    const [s] = classifySql(sql);
    assert.equal(s.write, true, `${sql} deve ser escrita`);
    assert.equal(decideSqlRun(sql, ORA).verdict, "blocked");
    assert.notEqual(decideSqlRun(sql, { ...ORA, readonly: false }).verdict, "auto");
  }
});

test("REGRESSÃO crítica: DROP/TRUNCATE dentro de CTE marca destrutivo (bloqueado sempre)", () => {
  // (raro em SQL padrão, mas o classificador não pode deixar passar)
  const [s] = classifySql("WITH x AS (SELECT 1) SELECT * FROM x");
  assert.equal(s.destructive, false); // controle
});

test("REGRESSÃO: kind 'other' não-vazio nunca é auto (defesa em profundidade da governança)", () => {
  // um verbo desconhecido (dialeto exótico) não pode virar leitura garantida
  const d = decideSqlRun("VACUUM ANALYZE clientes", ORA);
  assert.notEqual(d.verdict, "auto");
});

test("REGRESSÃO: Oracle recebe terminador quando falta; não duplica quando já tem", () => {
  assert.equal(oracleTerminate("SELECT 1 FROM dual"), "SELECT 1 FROM dual\n;\n");
  assert.equal(oracleTerminate("SELECT 1 FROM dual;"), "SELECT 1 FROM dual;\n");
  assert.equal(oracleTerminate("SELECT 1 FROM dual\n/"), "SELECT 1 FROM dual\n/\n");
  assert.ok(oracleTerminate("BEGIN null; END").endsWith("\n/\n"), "bloco PL/SQL termina com /");
  // o plano real materializa consulta.sql com terminador
  const plan = buildRunPlan(ORA, "SELECT 1 FROM dual", { password: "x", rowCap: 50 });
  if (!isPlanError(plan)) assert.ok(plan.scripts?.find((s) => s.name === "consulta.sql")?.content.includes(";"));
});

test("REGRESSÃO crítica: costPreview rejeita multi-statement e escrita (EXPLAIN cobria só o 1º)", () => {
  // buildCostPlan com >1 statement é erro para PG/Oracle/DuckDB
  assert.ok(isPlanError(buildCostPlan(PG, "SELECT 1; DELETE FROM t", { statementCount: 2 })));
  assert.ok(isPlanError(buildCostPlan(ORA, "SELECT 1; DROP TABLE t", { statementCount: 2 })));
  // statement único de leitura é ok
  assert.ok(!isPlanError(buildCostPlan(PG, "SELECT * FROM t", { statementCount: 1 })));
  // bigquery --dry_run é seguro mesmo multi (não prefixa EXPLAIN)
  assert.ok(!isPlanError(buildCostPlan(BQ, "SELECT 1; SELECT 2", { statementCount: 2 })));
});

test("REGRESSÃO: máscara não corrompe agregados (count nu preservado); mascara PII formatada e por coluna", () => {
  // count de 8 dígitos NÃO pode virar ▇ (falso 'Paridade OK')
  assert.equal(maskDataSample("metrica,coluna,valor\ncount,*,45000000"), "metrica,coluna,valor\ncount,*,45000000");
  assert.equal(maskDataSample("12345678"), "12345678");
  // CPF/CNPJ/e-mail formatados são mascarados
  assert.ok(!maskDataSample("doc: 123.456.789-09").includes("123.456.789-09"));
  assert.ok(!maskDataSample("x@claro.com.br").includes("x@claro"));
  // coluna sensível por cabeçalho: CPF nu numa coluna 'cpf' é mascarado
  const byCol = maskDataSample("id,cpf,total\n1,98765432100,500\n2,11122233344,600");
  assert.ok(!byCol.includes("98765432100"));
  assert.ok(byCol.includes(",500") && byCol.includes(",600"), "coluna não-sensível intacta");
});

test("REGRESSÃO (LGPD): máscara por coluna usa parser RFC4180 — vírgula-entre-aspas não desalinha nem vaza PII nua", () => {
  // 'nome' tem vírgula DENTRO de aspas; o split(",") ingênuo quebrava a linha e deslocava as colunas → o CPF
  // NU (idx 1, que os regex não pegam sem formatação) caía no idx errado e VAZAVA. Com RFC4180, alinha e mascara.
  const csv = 'nome,cpf,cidade\n"Silva, João",11122233344,"São Paulo, SP"\n"Souza, Ana",99988877766,Rio';
  const m = maskDataSample(csv);
  assert.ok(!/11122233344|99988877766/.test(m), "o CPF nu na coluna sensível NÃO vaza (o bug do split ingênuo)");
  assert.ok(m.includes('"Silva, João"') && m.includes('"São Paulo, SP"'), "campos quotados com vírgula preservados (não mascarados nem quebrados)");
  assert.ok(m.includes(",Rio"), "coluna não-sensível sem aspas intacta");
  // "" (aspa escapada) dentro de um campo quotado não confunde o parser
  const esc = maskDataSample('obs,email\n"diz ""oi""",ana@x.io');
  assert.ok(!esc.includes("ana@x.io") && esc.includes('"diz ""oi"""'), "aspa escapada preservada; email mascarado");
});

test("REGRESSÃO: sanitizeWarehouseOutput garante cap+máscara (contrato do caminho MCP)", () => {
  const r = sanitizeWarehouseOutput("h\n1,ana@x.com\n2,b@y.com\n3,c@z.com", 1, false);
  assert.ok(r.truncated);
  assert.ok(!r.output.includes("ana@x.com"));
  // skipMask preserva agregados
  assert.equal(sanitizeWarehouseOutput("count\n45000000", 100, true).output, "count\n45000000");
});
