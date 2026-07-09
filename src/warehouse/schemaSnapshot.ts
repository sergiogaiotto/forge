// Snapshot de schema do warehouse VIVO (Onda 3): SQL de inventário por dialeto (só metadados — nenhum
// dado de linha), parser do CSV para o MESMO índice do grounding dbt (DbtIndex) e (de)serialização do
// cache. Com o snapshot, o schema real do Oracle/PG/BigQuery entra no prompt e no gate semântico
// exatamente como o manifest dbt — mata a alucinação também fora de projetos dbt. PURO.
import { DbtIndex } from "../dbt/artifacts";
import { WarehouseKind } from "./types";

// Inventário de colunas (tabela qualificada, coluna, tipo). Escopo por schemas/owners/datasets:
// obrigatório no BigQuery (INFORMATION_SCHEMA é por dataset); nos demais, filtra quando informado.
export function columnsInventorySql(kind: WarehouseKind, schemas: string[]): string | { error: string } {
  const list = schemas.map((s) => `'${s.replace(/'/g, "''")}'`).join(", ");
  switch (kind) {
    case "oracle":
      return [
        "SELECT LOWER(owner || '.' || table_name) AS tabela, LOWER(column_name) AS coluna, data_type AS tipo",
        "FROM all_tab_columns",
        schemas.length > 0 ? `WHERE UPPER(owner) IN (${schemas.map((s) => `'${s.toUpperCase().replace(/'/g, "''")}'`).join(", ")})` : "WHERE owner NOT IN ('SYS','SYSTEM','XDB','MDSYS','CTXSYS','ORDSYS','OUTLN','DBSNMP')",
        "ORDER BY 1, column_id",
        "FETCH FIRST 50000 ROWS ONLY",
      ].join("\n");
    case "postgres":
    case "duckdb":
      return [
        "SELECT LOWER(table_schema || '.' || table_name) AS tabela, LOWER(column_name) AS coluna, data_type AS tipo",
        "FROM information_schema.columns",
        schemas.length > 0 ? `WHERE table_schema IN (${list})` : "WHERE table_schema NOT IN ('pg_catalog', 'information_schema')",
        "ORDER BY 1, ordinal_position",
        "LIMIT 50000",
      ].join("\n");
    case "bigquery":
      if (schemas.length === 0) return { error: "BigQuery precisa de `schemas` na conexão (datasets a inventariar) — INFORMATION_SCHEMA é por dataset." };
      return schemas
        .map((ds) =>
          [
            `SELECT LOWER(table_schema || '.' || table_name) AS tabela, LOWER(column_name) AS coluna, data_type AS tipo`,
            `FROM \`${ds}\`.INFORMATION_SCHEMA.COLUMNS`,
          ].join("\n")
        )
        .join("\nUNION ALL\n") + "\nORDER BY 1";
    default:
      return { error: "Snapshot de schema não disponível para este tipo de conexão." };
  }
}

export interface SchemaSnapshotRow {
  table: string;
  column: string;
  type?: string;
}

// CSV (tabela,coluna,tipo) → linhas. Tolera cabeçalho e aspas simples do CSV.
export function parseInventoryCsv(csv: string): SchemaSnapshotRow[] {
  const out: SchemaSnapshotRow[] = [];
  for (const raw of (csv ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(",").map((p) => p.trim().replace(/^"|"$/g, ""));
    if (parts.length < 2) continue;
    const [table, column, type] = parts;
    if (!table || !column || /^tabela$/i.test(table)) continue; // pula cabeçalho
    out.push({ table: table.toLowerCase(), column: column.toLowerCase(), type });
  }
  return out;
}

export interface WarehouseSnapshot {
  connectionId: string;
  kind: WarehouseKind;
  takenAt: string; // ISO
  rows: SchemaSnapshotRow[];
}

// Snapshot → DbtIndex (nós resourceType "source"): o gate semântico, o renderSchemaContext e as
// sugestões funcionam sobre o warehouse vivo sem NENHUMA mudança no motor.
export function snapshotToIndex(snap: WarehouseSnapshot): DbtIndex {
  const index = new DbtIndex(snap.takenAt);
  const byTable = new Map<string, SchemaSnapshotRow[]>();
  for (const r of snap.rows) {
    const arr = byTable.get(r.table) ?? [];
    arr.push(r);
    byTable.set(r.table, arr);
  }
  for (const [table, cols] of byTable) {
    const parts = table.split(".");
    const name = parts[parts.length - 1];
    const schema = parts.length > 1 ? parts.slice(0, -1).join(".") : undefined;
    index.addNode({
      uniqueId: `warehouse.${snap.connectionId}.${table}`,
      resourceType: "source",
      name,
      relation: table,
      schema,
      columns: cols.map((c) => ({ name: c.column, type: c.type })),
    });
  }
  return index;
}

// Junta índices (dbt + snapshots) num só, preservando o lineage (child/parent) do primeiro que tiver.
export function mergeIndexes(indexes: DbtIndex[]): DbtIndex {
  const valid = indexes.filter((i) => i && i.size() > 0);
  if (valid.length === 1) return valid[0];
  const merged = new DbtIndex(valid[0]?.generatedAt);
  for (const idx of valid) {
    for (const node of idx.nodes.values()) merged.addNode(node);
    for (const [k, v] of idx.childMap) if (!merged.childMap.has(k)) merged.childMap.set(k, v);
    for (const [k, v] of idx.parentMap) if (!merged.parentMap.has(k)) merged.parentMap.set(k, v);
  }
  return merged;
}

export function serializeSnapshot(snap: WarehouseSnapshot): string {
  return JSON.stringify(snap);
}

export function parseSnapshot(json: string): WarehouseSnapshot | null {
  try {
    const v = JSON.parse(json) as WarehouseSnapshot;
    if (!v || typeof v.connectionId !== "string" || !Array.isArray(v.rows)) return null;
    return v;
  } catch {
    return null;
  }
}
