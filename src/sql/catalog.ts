import { DbtIndex } from "../dbt/artifacts";
import { depthMap, splitStatements, stripSqlNoiseEx } from "./lex";
import type { SqlDialect } from "./dialect";

export interface SqlCatalogColumn {
  name: string;
  type?: string;
  nullable?: boolean;
  primaryKey?: boolean;
  references?: { table: string; column?: string };
  description?: string;
}

export interface SqlCatalogIndex {
  name: string;
  columns: string[];
  unique?: boolean;
}

export interface SqlCatalogTable {
  sourceId: string;
  name: string;
  schema?: string;
  qualifiedName: string;
  columns: SqlCatalogColumn[];
  indexes: SqlCatalogIndex[];
  description?: string;
}

export interface SqlCatalogSource {
  id: string;
  label: string;
  dialect: SqlDialect;
  importedAt: string;
  path?: string;
}

export interface SqlCatalog {
  version: 1;
  updatedAt: string;
  sources: SqlCatalogSource[];
  tables: SqlCatalogTable[];
}

const IDENT = String.raw`(?:"[^"]+"|` + "`[^`]+`" + String.raw`|\[[^\]]+\]|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|` + "`[^`]+`" + String.raw`|\[[^\]]+\]|[A-Za-z_][\w$]*))*`;

function cleanIdent(value: string): string {
  return value
    .split(".")
    .map((part) => part.trim().replace(/^["`[]/, "").replace(/["`\]]$/, "").toLowerCase())
    .join(".");
}

function splitQualified(value: string): { schema?: string; name: string; qualifiedName: string } {
  const qualifiedName = cleanIdent(value);
  const parts = qualifiedName.split(".");
  return {
    schema: parts.length > 1 ? parts.slice(0, -1).join(".") : undefined,
    name: parts[parts.length - 1],
    qualifiedName,
  };
}

function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: "'" | '"' | "`" | "]" | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (quote === "]") {
        if (ch === "]") quote = null;
      } else if (ch === quote) {
        if (text[i + 1] === quote) i++;
        else quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") quote = ch;
    else if (ch === "[") quote = "]";
    else if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

function columnList(value: string): string[] {
  return splitTopLevel(value).map(cleanIdent).filter(Boolean);
}

function parseReference(definition: string): { table: string; column?: string } | undefined {
  const match = new RegExp(String.raw`\bREFERENCES\s+(${IDENT})\s*(?:\(\s*(${IDENT})\s*\))?`, "i").exec(definition);
  if (!match) return undefined;
  return { table: cleanIdent(match[1]), column: match[2] ? cleanIdent(match[2]) : undefined };
}

function matchingParen(stripped: string, open: number): number {
  const depths = depthMap(stripped);
  const target = depths[open];
  for (let i = open + 1; i < stripped.length; i++) {
    if (stripped[i] === ")" && depths[i] === target) return i;
  }
  return -1;
}

export function parseDdlCatalog(input: {
  sql: string;
  sourceId: string;
  label: string;
  dialect: SqlDialect;
  path?: string;
  importedAt?: string;
}): SqlCatalog {
  const importedAt = input.importedAt ?? new Date().toISOString();
  const strippedResult = stripSqlNoiseEx(input.sql);
  const stripped = strippedResult.text;
  const tables: SqlCatalogTable[] = [];
  const byName = new Map<string, SqlCatalogTable>();

  for (const slice of splitStatements(stripped)) {
    const cleanStatement = stripped.slice(slice.start, slice.end);
    const originalStatement = input.sql.slice(slice.start, slice.end);
    const create = new RegExp(
      String.raw`^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:GLOBAL\s+TEMPORARY\s+|TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(${IDENT})\s*\(`,
      "i"
    ).exec(cleanStatement);
    if (create) {
      const open = cleanStatement.indexOf("(", create.index + create[0].length - 1);
      const close = matchingParen(cleanStatement, open);
      if (open < 0 || close < 0) continue;
      const tableName = splitQualified(create[1]);
      const table: SqlCatalogTable = {
        sourceId: input.sourceId,
        ...tableName,
        columns: [],
        indexes: [],
      };
      const definitions = splitTopLevel(originalStatement.slice(open + 1, close));
      const pendingPrimary = new Set<string>();
      const pendingRefs: Array<{ columns: string[]; table: string; refColumns: string[] }> = [];

      for (const rawDefinition of definitions) {
        const definition = rawDefinition.replace(/^\s*CONSTRAINT\s+(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[\w$]+)\s+/i, "").trim();
        const primary = /^PRIMARY\s+KEY\s*\(([\s\S]+)\)/i.exec(definition);
        if (primary) {
          for (const name of columnList(primary[1])) pendingPrimary.add(name);
          continue;
        }
        const foreign = new RegExp(String.raw`^FOREIGN\s+KEY\s*\(([\s\S]+?)\)\s+REFERENCES\s+(${IDENT})\s*\(([\s\S]+?)\)`, "i").exec(definition);
        if (foreign) {
          pendingRefs.push({ columns: columnList(foreign[1]), table: cleanIdent(foreign[2]), refColumns: columnList(foreign[3]) });
          continue;
        }
        if (/^(UNIQUE|CHECK|EXCLUDE|KEY)\b/i.test(definition)) continue;

        const column = new RegExp(String.raw`^\s*(${IDENT})\s+([\s\S]+)$`, "i").exec(definition);
        if (!column) continue;
        const name = cleanIdent(column[1]);
        const rest = column[2].trim();
        const boundary = /\s+(?=CONSTRAINT\b|NOT\s+NULL\b|NULL\b|PRIMARY\s+KEY\b|UNIQUE\b|REFERENCES\b|DEFAULT\b|CHECK\b|COLLATE\b|GENERATED\b|IDENTITY\b|COMMENT\b|ENCODE\b|DISTKEY\b|SORTKEY\b)/i.exec(rest);
        const type = (boundary ? rest.slice(0, boundary.index) : rest).trim();
        table.columns.push({
          name,
          type: type || undefined,
          nullable: /\bNOT\s+NULL\b/i.test(rest) ? false : /\bNULL\b/i.test(rest) ? true : undefined,
          primaryKey: /\bPRIMARY\s+KEY\b/i.test(rest) || undefined,
          references: parseReference(rest),
        });
      }
      for (const col of table.columns) {
        if (pendingPrimary.has(col.name)) col.primaryKey = true;
      }
      for (const ref of pendingRefs) {
        ref.columns.forEach((name, index) => {
          const col = table.columns.find((candidate) => candidate.name === name);
          if (col) col.references = { table: ref.table, column: ref.refColumns[index] };
        });
      }
      tables.push(table);
      byName.set(table.qualifiedName, table);
      byName.set(table.name, table);
      continue;
    }

    const index = new RegExp(
      String.raw`^\s*CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(${IDENT})\s+ON\s+(${IDENT})\s*\(([\s\S]+?)\)`,
      "i"
    ).exec(originalStatement);
    if (index) {
      const table = byName.get(cleanIdent(index[3])) ?? byName.get(cleanIdent(index[3]).split(".").pop() ?? "");
      table?.indexes.push({ name: cleanIdent(index[2]), columns: columnList(index[4]), unique: !!index[1] || undefined });
      continue;
    }

    const comment = new RegExp(String.raw`^\s*COMMENT\s+ON\s+TABLE\s+(${IDENT})\s+IS\s+'((?:''|[^'])*)'`, "i").exec(originalStatement);
    if (comment) {
      const table = byName.get(cleanIdent(comment[1])) ?? byName.get(cleanIdent(comment[1]).split(".").pop() ?? "");
      if (table) table.description = comment[2].replace(/''/g, "'");
    }
  }

  return {
    version: 1,
    updatedAt: importedAt,
    sources: [{ id: input.sourceId, label: input.label, dialect: input.dialect, importedAt, path: input.path }],
    tables,
  };
}

export function emptySqlCatalog(now = new Date().toISOString()): SqlCatalog {
  return { version: 1, updatedAt: now, sources: [], tables: [] };
}

export function parseSqlCatalog(json: string): SqlCatalog {
  try {
    const value = JSON.parse(json) as Partial<SqlCatalog>;
    if (value.version !== 1 || !Array.isArray(value.sources) || !Array.isArray(value.tables)) return emptySqlCatalog();
    return value as SqlCatalog;
  } catch {
    return emptySqlCatalog();
  }
}

export function mergeSqlCatalog(current: SqlCatalog, incoming: SqlCatalog): SqlCatalog {
  const sourceIds = new Set(incoming.sources.map((source) => source.id));
  return {
    version: 1,
    updatedAt: incoming.updatedAt,
    sources: [...current.sources.filter((source) => !sourceIds.has(source.id)), ...incoming.sources],
    tables: [...current.tables.filter((table) => !sourceIds.has(table.sourceId)), ...incoming.tables],
  };
}

export function catalogToIndex(catalog: SqlCatalog): DbtIndex {
  const index = new DbtIndex(catalog.updatedAt);
  for (const table of catalog.tables) {
    index.addNode({
      uniqueId: `catalog.${table.sourceId}.${table.qualifiedName}`,
      resourceType: "source",
      name: table.name,
      relation: table.qualifiedName,
      schema: table.schema,
      columns: table.columns.map((column) => ({ name: column.name, type: column.type, description: column.description })),
    });
  }
  return index;
}

export function renderCatalogSummary(catalog: SqlCatalog): string {
  const columnCount = catalog.tables.reduce((count, table) => count + table.columns.length, 0);
  const relationshipCount = catalog.tables.reduce(
    (count, table) => count + table.columns.filter((column) => !!column.references).length,
    0
  );
  const indexCount = catalog.tables.reduce((count, table) => count + table.indexes.length, 0);
  return `${catalog.tables.length} tabela(s), ${columnCount} coluna(s), ${relationshipCount} relacionamento(s), ${indexCount} indice(s)`;
}
