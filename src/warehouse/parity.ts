// Paridade de dados compliance-safe (Onda 4): perfil por AGREGADOS (count, não-nulos, distintos,
// min/max) — nenhuma LINHA sai do banco, só estatísticas; seguro para tabelas com PII (o modo
// "profile" do data-diff clássico). Gera o SQL por dialeto, parseia o CSV e compara host-side —
// funciona INTRA warehouse (mesma conexão) e ENTRE warehouses (roda um perfil em cada conexão).
// Colunas vêm do índice de schema quando conhecido (cap 12); sem schema, compara só COUNT(*). PURO.
import { WarehouseKind } from "./types";

const MAX_PROFILE_COLUMNS = 12;

function q(ident: string, kind: WarehouseKind): string {
  if (!/^[\w.$]+$/.test(ident)) return ident; // já qualificado/quotado — não mexe
  return kind === "bigquery" ? `\`${ident}\`` : ident;
}

// Perfil de UMA tabela: uma linha por métrica (metrica,coluna,valor) via UNION ALL — formato
// uniforme entre dialetos e trivial de comparar.
export function profileSql(kind: WarehouseKind, table: string, columns: string[]): string {
  const cols = columns.slice(0, MAX_PROFILE_COLUMNS);
  const t = q(table, kind);
  const parts: string[] = [`SELECT 'count' AS metrica, '*' AS coluna, CAST(COUNT(*) AS VARCHAR(64)) AS valor FROM ${t}`];
  for (const c of cols) {
    parts.push(`SELECT 'nao_nulos', '${c}', CAST(COUNT(${c}) AS VARCHAR(64)) FROM ${t}`);
    parts.push(`SELECT 'distintos', '${c}', CAST(COUNT(DISTINCT ${c}) AS VARCHAR(64)) FROM ${t}`);
  }
  let sql = parts.join("\nUNION ALL\n");
  if (kind === "bigquery") sql = sql.replace(/VARCHAR\(64\)/g, "STRING");
  if (kind === "oracle") sql = sql.replace(/VARCHAR\(64\)/g, "VARCHAR2(64)");
  return sql;
}

export type Profile = Map<string, string>; // "metrica·coluna" → valor

export function parseProfileCsv(csv: string): Profile {
  const p: Profile = new Map();
  for (const raw of (csv ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^metrica\b/i.test(line)) continue;
    const parts = line.split(",").map((x) => x.trim().replace(/^"|"$/g, ""));
    if (parts.length < 3) continue;
    p.set(`${parts[0].toLowerCase()}·${parts[1].toLowerCase()}`, parts[2]);
  }
  return p;
}

export interface ParityDiff {
  metric: string;
  column: string;
  left: string;
  right: string;
}

export function compareProfiles(a: Profile, b: Profile): { equal: boolean; diffs: ParityDiff[]; checked: number } {
  const keys = new Set([...a.keys(), ...b.keys()]);
  const diffs: ParityDiff[] = [];
  for (const k of keys) {
    const [metric, column] = k.split("·");
    const left = a.get(k) ?? "(ausente)";
    const right = b.get(k) ?? "(ausente)";
    if (left !== right) diffs.push({ metric, column, left, right });
  }
  return { equal: diffs.length === 0, diffs, checked: keys.size };
}

export function renderParityCard(leftLabel: string, rightLabel: string, result: { equal: boolean; diffs: ParityDiff[]; checked: number }): string {
  const head = `### Paridade de dados · \`${leftLabel}\` × \`${rightLabel}\``;
  if (result.equal) {
    return [head, "", `✅ **Paridade OK** — ${result.checked} métricas conferem (count, não-nulos e distintos por coluna).`, "", "_Comparação por AGREGADOS: nenhuma linha saiu dos bancos (compliance-safe)._"].join("\n");
  }
  const rows = result.diffs.slice(0, 20).map((d) => `| ${d.metric} | \`${d.column}\` | ${d.left} | ${d.right} |`);
  return [
    head,
    "",
    `❌ **${result.diffs.length} divergência${result.diffs.length === 1 ? "" : "s"}** em ${result.checked} métricas:`,
    "",
    `| métrica | coluna | ${leftLabel} | ${rightLabel} |`,
    "|---|---|---|---|",
    ...rows,
    result.diffs.length > 20 ? `\n_… +${result.diffs.length - 20} divergências._` : "",
    "",
    "_Comparação por AGREGADOS: nenhuma linha saiu dos bancos (compliance-safe). Divergência em `count` = volume; em `distintos` = duplicatas/dedup; em `nao_nulos` = perda de dados na carga._",
  ].join("\n");
}

// Argumentos do /paridade: "tabela_a tabela_b" (mesma conexão default), com prefixo opcional
// "conexao:tabela" em cada lado para paridade ENTRE warehouses.
export function parseParityArgs(args: string): { left: { conn?: string; table: string }; right: { conn?: string; table: string } } | { error: string } {
  const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 2) return { error: "Uso: `/paridade tabela_a tabela_b` — opcionalmente `conexao:tabela` em cada lado (paridade entre warehouses)." };
  const parse = (s: string) => {
    const i = s.indexOf(":");
    return i > 0 ? { conn: s.slice(0, i), table: s.slice(i + 1) } : { table: s };
  };
  return { left: parse(parts[0]), right: parse(parts[1]) };
}
