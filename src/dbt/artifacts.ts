// Grounding determinístico via artefatos do dbt: parse do target/manifest.json (+ catalog.json quando
// existir) para um índice consultável — tabelas/colunas REAIS que (a) entram no prompt como "schema
// real" (anti-alucinação: o modelo consulta em vez de lembrar), (b) validam o SQL gerado ANTES do
// Aplicar (tabela/coluna fantasma vira achado com sugestão) e (c) dão o raio de explosão (/impacto)
// via child_map. Zero dependências: só o subconjunto do JSON que usamos, tolerante a versões de
// manifest (v7+). PURO/testável — o I/O (achar o projeto, ler os arquivos) vive em loader.ts.

import { hostT } from "../i18n";

export interface DbtColumn {
  name: string;
  type?: string;
  description?: string;
}

export type DbtResourceType = "model" | "seed" | "snapshot" | "source" | "test" | "exposure" | "other";

export interface DbtNode {
  uniqueId: string;
  resourceType: DbtResourceType;
  name: string; // nome LÓGICO — o que {{ ref('…') }}/{{ source('…','…') }} usa
  alias?: string; // nome FÍSICO quando difere do lógico (config alias / identifier de source)
  relation: string; // schema.físico como aparece no SQL compilado (minúsculas)
  database?: string;
  schema?: string;
  originalFilePath?: string; // ex.: models/staging/stg_orders.sql (barras pra frente)
  materialized?: string;
  columns: DbtColumn[];
  // Chaves de lookup ADICIONAIS (sources: "source_name.name", "source_name.identifier" — é assim que
  // o strip de Jinja materializa um {{ source() }}).
  extraLookup?: string[];
}

export interface DbtDownstream {
  direct: DbtNode[]; // modelos/seeds/snapshots imediatamente dependentes
  transitive: DbtNode[]; // fechamento (inclui os diretos), sem o próprio nó
  maxDepth: number;
  tests: number; // testes no fechamento
  exposures: string[]; // nomes de exposures no fechamento
}

const REL_TYPES = new Set<DbtResourceType>(["model", "seed", "snapshot", "source"]);

function asRecord(x: unknown): Record<string, unknown> {
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
}

function str(x: unknown): string | undefined {
  return typeof x === "string" && x.length > 0 ? x : undefined;
}

function normPath(p: string | undefined): string | undefined {
  return p ? p.replace(/\\/g, "/").replace(/^\.\//, "") : undefined;
}

function resourceType(raw: unknown): DbtResourceType {
  const t = str(raw)?.toLowerCase();
  if (t === "model" || t === "seed" || t === "snapshot" || t === "source" || t === "test" || t === "exposure") return t;
  return "other";
}

function parseColumns(raw: unknown): DbtColumn[] {
  const rec = asRecord(raw);
  const out: DbtColumn[] = [];
  for (const [name, val] of Object.entries(rec)) {
    const v = asRecord(val);
    out.push({ name: (str(v.name) ?? name).toLowerCase(), type: str(v.data_type) ?? str(v.type), description: str(v.description) });
  }
  return out;
}

// Índice consultável dos artefatos. Todas as chaves de lookup em minúsculas.
export class DbtIndex {
  readonly nodes = new Map<string, DbtNode>(); // por uniqueId (todos os tipos)
  readonly childMap = new Map<string, string[]>();
  readonly parentMap = new Map<string, string[]>();
  readonly generatedAt?: string; // metadata.generated_at do manifest
  private readonly byLookup = new Map<string, DbtNode>(); // nome | alias | schema.nome | db.schema.físico → nó relacional
  private readonly byPath = new Map<string, DbtNode>(); // original_file_path → nó
  private relCache?: DbtNode[]; // cache de relationalNodes() — índice imutável após o parse
  private readonly colSets = new Map<string, Set<string>>(); // uniqueId → Set de nomes de coluna

  constructor(generatedAt?: string) {
    this.generatedAt = generatedAt;
  }

  addNode(n: DbtNode): void {
    this.nodes.set(n.uniqueId, n);
    this.relCache = undefined;
    if (!REL_TYPES.has(n.resourceType)) return;
    const physical = n.alias ?? n.name;
    const keys = new Set<string>([n.name.toLowerCase(), physical.toLowerCase(), n.relation, ...(n.extraLookup ?? [])]);
    if (n.schema) keys.add(`${n.schema}.${n.name}`.toLowerCase());
    if (n.database && n.schema) keys.add(`${n.database}.${n.schema}.${physical}`.toLowerCase());
    for (const k of keys) if (k && !this.byLookup.has(k)) this.byLookup.set(k, n);
    const p = normPath(n.originalFilePath);
    if (p) this.byPath.set(p.toLowerCase(), n);
  }

  relationalNodes(): DbtNode[] {
    // Cacheado: chamado a cada geração/proposta (renderSchemaContext/suggestTable) — o índice é
    // imutável após o parse, então varrer/realocar toda vez era desperdício (revisão adversarial).
    if (!this.relCache) this.relCache = [...this.nodes.values()].filter((n) => REL_TYPES.has(n.resourceType));
    return this.relCache;
  }

  // Set de colunas por nó, construído sob demanda (lookup O(1) no score lexical do schema-context).
  columnSet(uniqueId: string): Set<string> {
    let s = this.colSets.get(uniqueId);
    if (!s) {
      s = new Set((this.nodes.get(uniqueId)?.columns ?? []).map((c) => c.name));
      this.colSets.set(uniqueId, s);
    }
    return s;
  }

  // Resolve um nome de tabela como aparece no SQL: completo, schema.tabela ou só o nome.
  findTable(sqlName: string): DbtNode | undefined {
    const n = sqlName.toLowerCase();
    const direct = this.byLookup.get(n);
    if (direct) return direct;
    const parts = n.split(".");
    if (parts.length > 1) return this.byLookup.get(parts.slice(-2).join(".")) ?? this.byLookup.get(parts[parts.length - 1]);
    return undefined;
  }

  findByPath(relPath: string): DbtNode | undefined {
    const p = normPath(relPath)?.toLowerCase() ?? "";
    if (this.byPath.has(p)) return this.byPath.get(p);
    // o arquivo pode vir com prefixo do subdiretório do projeto dbt (ex.: transform/models/…)
    for (const [key, node] of this.byPath) {
      if (p.endsWith("/" + key) || key.endsWith("/" + p)) return node;
    }
    return undefined;
  }

  findModelByName(name: string): DbtNode | undefined {
    const n = name.toLowerCase().trim();
    const node = this.byLookup.get(n);
    if (node && node.resourceType !== "source") return node;
    return this.relationalNodes().find(
      (x) => x.resourceType === "model" && (x.name.toLowerCase() === n || x.alias?.toLowerCase() === n)
    );
  }

  // Sugestão "você quis dizer": menor distância de edição entre os nomes conhecidos (≤ 2 ou prefixo).
  suggestTable(sqlName: string): string | undefined {
    const target = sqlName.toLowerCase().split(".").pop() ?? "";
    let best: { name: string; d: number } | undefined;
    for (const n of this.relationalNodes()) {
      const d = levenshtein(target, n.name.toLowerCase(), 3);
      if (d !== undefined && (!best || d < best.d)) best = { name: n.name, d };
    }
    if (best && best.d <= 2) return best.name;
    const pref = this.relationalNodes().find((n) => n.name.toLowerCase().startsWith(target) || target.startsWith(n.name.toLowerCase()));
    return pref?.name;
  }

  suggestColumn(node: DbtNode, col: string): string | undefined {
    let best: { name: string; d: number } | undefined;
    for (const c of node.columns) {
      const d = levenshtein(col.toLowerCase(), c.name, 3);
      if (d !== undefined && (!best || d < best.d)) best = { name: c.name, d };
    }
    return best && best.d <= 2 ? best.name : undefined;
  }

  // Fechamento downstream via child_map (BFS) — o raio de explosão de uma mudança.
  downstream(uniqueId: string): DbtDownstream {
    const seen = new Set<string>([uniqueId]);
    const transitive: DbtNode[] = [];
    const direct: DbtNode[] = [];
    const exposures: string[] = [];
    let tests = 0;
    let maxDepth = 0;
    let frontier = [uniqueId];
    let depth = 0;
    while (frontier.length > 0) {
      depth++;
      const next: string[] = [];
      for (const uid of frontier) {
        for (const child of this.childMap.get(uid) ?? []) {
          if (seen.has(child)) continue;
          seen.add(child);
          next.push(child);
          const node = this.nodes.get(child);
          if (!node) continue;
          if (node.resourceType === "test") {
            tests++;
          } else if (node.resourceType === "exposure") {
            exposures.push(node.name);
          } else if (REL_TYPES.has(node.resourceType)) {
            transitive.push(node);
            if (depth === 1) direct.push(node);
            maxDepth = depth;
          }
        }
      }
      frontier = next;
    }
    return { direct, transitive, maxDepth, tests, exposures };
  }

  upstreamDirect(uniqueId: string): DbtNode[] {
    return (this.parentMap.get(uniqueId) ?? [])
      .map((uid) => this.nodes.get(uid))
      .filter((n): n is DbtNode => !!n && REL_TYPES.has(n.resourceType));
  }

  size(): number {
    return this.relationalNodes().length;
  }
}

// Parse tolerante do manifest (+ catalog opcional). Nunca lança para JSON bem-formado de qualquer
// versão: campos ausentes viram undefined/[] (fail-open — melhor um índice parcial que nenhum).
export function parseDbtArtifacts(manifestJson: unknown, catalogJson?: unknown): DbtIndex {
  const manifest = asRecord(manifestJson);
  const catalog = asRecord(catalogJson);
  const catNodes = { ...asRecord(catalog.nodes), ...asRecord(catalog.sources) };
  const meta = asRecord(manifest.metadata);
  const index = new DbtIndex(str(meta.generated_at));

  const catalogColumns = (uid: string): DbtColumn[] => parseColumns(asRecord(catNodes[uid]).columns);

  const mergeColumns = (uid: string, manifestCols: DbtColumn[]): DbtColumn[] => {
    const fromCatalog = catalogColumns(uid);
    if (fromCatalog.length === 0) return manifestCols;
    // catálogo tem o schema REAL do warehouse (tipos); descrições vêm do manifest
    const desc = new Map(manifestCols.map((c) => [c.name, c.description]));
    return fromCatalog.map((c) => ({ ...c, description: c.description ?? desc.get(c.name) }));
  };

  for (const [uid, raw] of Object.entries(asRecord(manifest.nodes))) {
    const v = asRecord(raw);
    const rt = resourceType(v.resource_type);
    // name = nome LÓGICO (o que ref() usa); alias = nome físico quando difere (config alias).
    const name = (str(v.name) ?? uid.split(".").pop() ?? uid).toLowerCase();
    const alias = str(v.alias)?.toLowerCase();
    const physical = alias ?? name;
    const schema = str(v.schema)?.toLowerCase();
    index.addNode({
      uniqueId: uid,
      resourceType: rt,
      name,
      alias: alias !== name ? alias : undefined,
      relation: schema ? `${schema}.${physical}` : physical,
      database: str(v.database)?.toLowerCase(),
      schema,
      originalFilePath: normPath(str(v.original_file_path)),
      materialized: str(asRecord(v.config).materialized),
      columns: mergeColumns(uid, parseColumns(v.columns)),
    });
  }
  for (const [uid, raw] of Object.entries(asRecord(manifest.sources))) {
    const v = asRecord(raw);
    // name = nome LÓGICO do yml; identifier = tabela física; source_name = namespace do source().
    // O strip de Jinja materializa {{ source('raw','orders') }} como "raw.orders" — registra as
    // chaves LÓGICAS além das físicas (achado da revisão adversarial: identifier != name quebrava tudo).
    const logical = (str(v.name) ?? uid.split(".").pop() ?? uid).toLowerCase();
    const identifier = (str(v.identifier) ?? logical).toLowerCase();
    const sourceName = str(v.source_name)?.toLowerCase();
    const schema = (str(v.schema) ?? sourceName)?.toLowerCase();
    const extraLookup = sourceName ? [`${sourceName}.${logical}`, `${sourceName}.${identifier}`] : [];
    index.addNode({
      uniqueId: uid,
      resourceType: "source",
      name: logical,
      alias: identifier !== logical ? identifier : undefined,
      relation: schema ? `${schema}.${identifier}` : identifier,
      database: str(v.database)?.toLowerCase(),
      schema,
      columns: mergeColumns(uid, parseColumns(v.columns)),
      extraLookup,
    });
  }
  for (const [uid, raw] of Object.entries(asRecord(manifest.exposures))) {
    const v = asRecord(raw);
    index.addNode({
      uniqueId: uid,
      resourceType: "exposure",
      name: str(v.name) ?? uid,
      relation: "",
      columns: [],
    });
  }
  for (const [uid, kids] of Object.entries(asRecord(manifest.child_map))) {
    if (Array.isArray(kids)) index.childMap.set(uid, kids.filter((k): k is string => typeof k === "string"));
  }
  for (const [uid, parents] of Object.entries(asRecord(manifest.parent_map))) {
    if (Array.isArray(parents)) index.parentMap.set(uid, parents.filter((k): k is string => typeof k === "string"));
  }
  return index;
}

// Distância de edição com teto (poda: acima de `max`, retorna undefined — só queremos vizinhos).
export function levenshtein(a: string, b: string, max: number): number | undefined {
  if (Math.abs(a.length - b.length) > max) return undefined;
  const prev = new Array<number>(b.length + 1);
  const cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return undefined;
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length] <= max ? prev[b.length] : undefined;
}

// ---- blocos para o prompt / cartões ------------------------------------------------------------------

// Nomes vindos do manifest entram em cartões markdown host-computados — remove os metacaracteres que
// permitiriam injetar formatação/quebrar tabelas (backtick, pipe, colchetes; achado da revisão).
export function mdSafe(s: string): string {
  return (s ?? "").replace(/[`|[\]]/g, "").slice(0, 120);
}

// Seção "schema real" injetada no contexto da geração: top-K tabelas mais relevantes para a QUERY do
// dev (score lexical por nome/coluna). Vazio quando nada casa — não gasta orçamento à toa.
// Cap de tokens + Set de colunas por nó: roda a cada geração e não pode custar O(nós×tokens×colunas)
// numa mensagem longa (revisão adversarial mediu até ~1s de bloqueio do host sem os caps).
export function renderSchemaContext(index: DbtIndex, query: string, topK = 8): string {
  const tokens = [...new Set((query.toLowerCase().match(/[a-z_][\w]{2,}/g) ?? []))].slice(0, 64);
  if (tokens.length === 0) return "";
  const scored = index
    .relationalNodes()
    .map((n) => {
      let score = 0;
      const cols = index.columnSet(n.uniqueId);
      for (const t of tokens) {
        if (n.name.includes(t) || t.includes(n.name)) score += 3;
        if (cols.has(t)) score += 1;
      }
      return { n, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
  if (scored.length === 0) return "";
  const lines = scored.map(({ n }) => {
    const cols = n.columns.slice(0, 20).map((c) => (c.type ? `${c.name} ${c.type}` : c.name));
    const more = n.columns.length > 20 ? ` +${n.columns.length - 20} colunas` : "";
    const colTxt = cols.length > 0 ? ` — colunas: ${cols.join(", ")}${more}` : " — (colunas não documentadas; rode `dbt docs generate` para o schema real)";
    return `- ${n.relation} (${n.resourceType}${n.materialized ? ", " + n.materialized : ""})${colTxt}`;
  });
  return [
    `Schema real do projeto dbt (target/manifest.json — use ESTES nomes de tabela/coluna, não invente):`,
    ...lines,
  ].join("\n");
}

// Cartão do /impacto: raio de explosão de um modelo via lineage do manifest. Todos os nomes passam
// por mdSafe — vêm do manifest do usuário e o cartão é markdown "confiável" (host-computado).
export function renderImpactCard(index: DbtIndex, node: DbtNode): string {
  const down = index.downstream(node.uniqueId);
  const up = index.upstreamDirect(node.uniqueId);
  const safe = mdSafe(node.name);
  const fmt = (ns: DbtNode[], cap = 12) =>
    ns.length === 0 ? "—" : ns.slice(0, cap).map((n) => `\`${mdSafe(n.name)}\``).join(", ") + (ns.length > cap ? ` … (+${ns.length - cap})` : "");
  const head = hostT("dbt.impact.head", { name: safe });
  if (down.transitive.length === 0 && down.tests === 0) {
    return [
      head,
      "",
      hostT("dbt.impact.local", { name: safe }),
      "",
      hostT("dbt.impact.upstream", { list: fmt(up) }),
      "",
      freshness(index),
    ].join("\n");
  }
  return [
    head,
    "",
    `| | |`,
    `|---|---|`,
    hostT("dbt.impact.downDirect", { n: down.direct.length, list: fmt(down.direct) }),
    hostT("dbt.impact.downTransitive", { count: down.transitive.length, depth: down.maxDepth }),
    hostT("dbt.impact.tests", { n: down.tests }),
    ...(down.exposures.length > 0 ? [hostT("dbt.impact.exposures", { list: down.exposures.map((e) => `\`${mdSafe(e)}\``).join(", ") })] : []),
    hostT("dbt.impact.upstreamRow", { list: fmt(up) }),
    "",
    hostT("dbt.impact.warning", { name: safe, count: down.transitive.length + down.tests }),
    "",
    freshness(index),
  ].join("\n");
}

function freshness(index: DbtIndex): string {
  const when = index.generatedAt ? hostT("dbt.impact.when", { ts: index.generatedAt.slice(0, 19).replace("T", " ") }) : "";
  return hostT("dbt.impact.freshness", { when });
}
