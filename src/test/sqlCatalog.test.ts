import assert from "node:assert/strict";
import { test } from "node:test";
import {
  catalogToIndex,
  mergeSqlCatalog,
  parseDdlCatalog,
  parseSqlCatalog,
} from "../sql/catalog";
import { findDialectRisks, resolveSqlDialect } from "../sql/dialect";

const ddl = `
CREATE TABLE sales.customers (
  id BIGINT PRIMARY KEY,
  name VARCHAR(120) NOT NULL
);

CREATE TABLE sales.orders (
  id BIGINT NOT NULL,
  customer_id BIGINT NOT NULL,
  total DECIMAL(18, 2),
  CONSTRAINT orders_pk PRIMARY KEY (id),
  CONSTRAINT orders_customer_fk FOREIGN KEY (customer_id)
    REFERENCES sales.customers(id)
);

CREATE UNIQUE INDEX orders_customer_idx
  ON sales.orders(customer_id, id);

COMMENT ON TABLE sales.orders IS 'Pedidos faturados';
`;

test("catálogo DDL extrai tabelas, tipos, chaves, relacionamentos e índices", () => {
  const catalog = parseDdlCatalog({
    sql: ddl,
    sourceId: "sales-ddl",
    label: "schema.sql",
    dialect: "postgres",
    importedAt: "2026-07-23T00:00:00.000Z",
  });

  assert.equal(catalog.tables.length, 2);
  const orders = catalog.tables.find((table) => table.qualifiedName === "sales.orders");
  assert.ok(orders);
  assert.equal(orders.description, "Pedidos faturados");
  assert.equal(orders.columns.find((column) => column.name === "id")?.primaryKey, true);
  assert.deepEqual(
    orders.columns.find((column) => column.name === "customer_id")?.references,
    { table: "sales.customers", column: "id" }
  );
  assert.deepEqual(orders.indexes[0], {
    name: "orders_customer_idx",
    columns: ["customer_id", "id"],
    unique: true,
  });
});

test("catálogo substitui apenas a fonte reimportada e alimenta o índice semântico", () => {
  const first = parseDdlCatalog({
    sql: "CREATE TABLE a (id INT);",
    sourceId: "one",
    label: "one.sql",
    dialect: "ansi",
    importedAt: "2026-07-23T00:00:00.000Z",
  });
  const second = parseDdlCatalog({
    sql: "CREATE TABLE b (id INT, value TEXT);",
    sourceId: "two",
    label: "two.sql",
    dialect: "ansi",
    importedAt: "2026-07-23T00:01:00.000Z",
  });
  const replacement = parseDdlCatalog({
    sql: "CREATE TABLE a_new (id BIGINT);",
    sourceId: "one",
    label: "one.sql",
    dialect: "postgres",
    importedAt: "2026-07-23T00:02:00.000Z",
  });

  const merged = mergeSqlCatalog(mergeSqlCatalog(first, second), replacement);
  assert.deepEqual(merged.tables.map((table) => table.name).sort(), ["a_new", "b"]);
  assert.equal(catalogToIndex(merged).findTable("a_new")?.columns[0]?.type, "BIGINT");
  assert.equal(parseSqlCatalog(JSON.stringify(merged)).tables.length, 2);
  assert.equal(parseSqlCatalog("{invalid").tables.length, 0);
});

test("resolução de dialeto segue configuração, conexão, arquivo, detecção e ANSI", () => {
  assert.equal(resolveSqlDialect({ configured: "oracle", sql: "SELECT 1" }).dialect, "oracle");
  assert.equal(resolveSqlDialect({ connectionKind: "postgres", sql: "SELECT 1" }).source, "connection");
  assert.equal(resolveSqlDialect({ fileName: "query.bigquery.sql", sql: "SELECT 1" }).dialect, "bigquery");
  assert.equal(resolveSqlDialect({ sql: "SELECT * FROM t QUALIFY row_number() OVER() = 1" }).dialect, "bigquery");
  assert.equal(resolveSqlDialect({ sql: "SELECT 1" }).dialect, "ansi");
});

test("riscos de dialeto detectam sintaxe incompatível", () => {
  assert.deepEqual(findDialectRisks("SELECT * FROM t LIMIT 10", "oracle").map((risk) => risk.rule), ["limit"]);
  assert.deepEqual(findDialectRisks("SELECT * FROM t QUALIFY n = 1", "postgres").map((risk) => risk.rule), ["qualify"]);
});
