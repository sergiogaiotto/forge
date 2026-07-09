// Gate semântico de schema: confere as tabelas/colunas do SQL gerado contra o schema REAL (índice dos
// artefatos dbt) — a defesa em profundidade contra alucinação: mesmo que o modelo invente um nome, o
// achado aparece ANTES do Aplicar, com sugestão ("você quis dizer …?"). Sempre ADVISORY na Onda 1: o
// manifest pode estar desatualizado, então o achado orienta, não bloqueia. PURO/testável.
import { DbtIndex } from "../dbt/artifacts";
import { SqlFinding } from "./antipatterns";
import { SqlStatement } from "./classify";
import { lineOf } from "./lex";

// Prefixos qualificadores que NÃO são alias de tabela referenciável (função de janela, structs BQ…).
const NON_TABLE_PREFIX = new Set(["unnest", "lateral", "table", "values"]);

export function checkAgainstSchema(stmts: SqlStatement[], index: DbtIndex, baseLineOf: (stmt: SqlStatement) => number): SqlFinding[] {
  const out: SqlFinding[] = [];
  if (index.size() === 0) return out;
  // Dedupe da PROPOSTA inteira (não por statement): a mesma tabela desconhecida em N statements de
  // uma migração viraria N achados idênticos — um basta.
  const reportedTables = new Set<string>();

  for (const stmt of stmts) {
    const baseLine = baseLineOf(stmt);
    const cteSet = new Set(stmt.ctes);
    const lineAt = (off: number) => baseLine + lineOf(stmt.stripped, off) - 1;

    // ---- tabelas -------------------------------------------------------------------------------
    const unknownTables = new Set<string>();
    for (const t of stmt.tables) {
      if (cteSet.has(t) || /^__\w+__$/.test(t)) continue;
      if (index.findTable(t)) continue;
      unknownTables.add(t);
      if (reportedTables.has(t)) continue;
      reportedTables.add(t);
      const sug = index.suggestTable(t);
      out.push({
        rule: "tabela-desconhecida",
        message: `A tabela "${t}" não existe no manifest do dbt${sug ? ` — você quis dizer "${sug}"?` : " (nem como model, source, seed ou snapshot)."}`,
        severity: "warn",
        confidence: "média", // o manifest pode estar desatualizado — orienta, não bloqueia
        line: baseLine,
      });
    }

    // ---- colunas qualificadas (alias.coluna / tabela.coluna) ------------------------------------
    const s = stmt.stripped;
    const colRe = /(?<![\w$.])([A-Za-z_][\w$]*)\s*\.\s*([A-Za-z_][\w$]*)(?![\w$(.])/g;
    let m: RegExpExecArray | null;
    const reported = new Set<string>();
    while ((m = colRe.exec(s))) {
      const prefix = m[1].toLowerCase();
      const col = m[2].toLowerCase();
      if (NON_TABLE_PREFIX.has(prefix) || col === "*") continue;
      // resolve o prefixo: alias declarado > tabela citada no statement; sem resolução → não opina
      const tableName = stmt.aliases.get(prefix) ?? (stmt.tables.includes(prefix) ? prefix : undefined);
      if (!tableName || cteSet.has(tableName) || unknownTables.has(tableName)) continue;
      // `schema.tabela` inteiro pode ser uma tabela conhecida (não é alias.coluna) — não opina
      if (index.findTable(`${prefix}.${col}`)) continue;
      const node = index.findTable(tableName);
      if (!node || node.columns.length === 0) continue; // sem colunas documentadas → sem opinião
      if (node.columns.some((c) => c.name === col)) continue;
      const key = `${tableName}.${col}`;
      if (reported.has(key)) continue;
      reported.add(key);
      const sug = index.suggestColumn(node, col);
      out.push({
        rule: "coluna-desconhecida",
        message: `A coluna "${col}" não existe em "${node.relation}"${sug ? ` — você quis dizer "${sug}"?` : ` (colunas conhecidas: ${node.columns.slice(0, 12).map((c) => c.name).join(", ")}${node.columns.length > 12 ? ", …" : ""}).`}`,
        severity: "warn",
        confidence: node.columns.length > 0 ? "média" : "baixa",
        line: lineAt(m.index),
      });
    }
  }
  return out;
}
