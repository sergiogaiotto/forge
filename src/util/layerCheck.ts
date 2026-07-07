// Gate de ARQUITETURA (P2): a "regra de ouro" das arquiteturas que apontam para dentro — a camada INTERNA
// (domínio/entidades/model) NÃO pode importar a camada EXTERNA (adapters/infra/repository/controllers). O
// mypy/compileall não pega isso: um domínio importando adapters compila e tipa, mas quebra a arquitetura
// que o dev escolheu. Este módulo é a fitness function (estilo import-linter/ArchUnit) — PURO/testável; o
// Controller.runProjectGate a materializa num GateCheckResult que bloqueia o Aplicar do arquivo violador.
import { ProjectArchitecture, ProjectLanguage } from "../shared/protocol";

// Aliases de diretório da camada INTERNA (o centro puro que não pode depender de fora).
const INNER: Record<ProjectArchitecture, string[]> = {
  hexagonal: ["domain", "entities", "entity"],
  clean: ["entities", "entity", "domain"],
  layered: ["model", "models", "entity", "entities", "domain"],
  mvc: ["model", "models"],
};

// Aliases da camada EXTERNA. SÓ nomes DISTINTIVOS de camada — nada de http/api/web/db (colidiriam com
// stdlib/3rd-party e gerariam falso-positivo). O casamento ainda exige que o import resolva para um
// arquivo GERADO nesta camada (ver findLayerViolations), então um `import requests` nunca é violação.
const OUTER: Record<ProjectArchitecture, string[]> = {
  hexagonal: ["adapters", "adapter", "infrastructure", "infra", "frameworks", "framework", "repositories", "persistence", "controllers"],
  clean: ["adapters", "adapter", "infrastructure", "infra", "frameworks", "framework", "controllers", "presenters", "gateways"],
  layered: ["repository", "repositories", "service", "services", "presentation", "controllers", "controller"],
  mvc: ["view", "views", "controller", "controllers"],
};

// Descrição pt-BR da regra por arquitetura, para a mensagem do gate.
export const LAYER_RULE: Record<ProjectArchitecture, string> = {
  hexagonal: "o domínio não pode importar adapters/infraestrutura — a dependência aponta para DENTRO (os adapters implementam as ports; o domínio não os conhece)",
  clean: "as camadas internas (entities/use cases) não conhecem as externas (adapters/frameworks) — a regra da dependência aponta para dentro",
  layered: "a camada de modelo/entidade não pode importar service/repository/apresentação (cada camada só chama a de baixo)",
  mvc: "o Model não pode importar View nem Controller (Model rico, sem conhecer a apresentação)",
};

type Layer = "inner" | "outer" | "other";

function norm(p: string): string {
  return (p ?? "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

// Camada de um caminho: o PRIMEIRO segmento (esq→dir) que casa um alias. Assim `domain/repositories.py`
// é INNER (uma porta do domínio), não OUTER, apesar do nome "repositories" — o diretório-raiz manda.
// Extensão de arquivo de código (Python OU TS/JS) — removida do último segmento antes de determinar a camada.
const CODE_EXT = /\.(py|tsx?|jsx?)$/i;

function layerOf(path: string, inner: string[], outer: string[]): Layer {
  // SÓ os DIRETÓRIOS decidem a camada — nunca o basename do arquivo. Sem isto, um módulo de RAIZ cujo nome
  // coincide com um alias (src/adapter.ts, src/service.ts, app/views.ts — idiomáticos em TS) seria rotulado
  // como a camada externa e falso-bloquearia quem o importa (achado da revisão; a intenção sempre foi "o
  // diretório-raiz manda"). O último segmento (nome do arquivo) é excluído da varredura.
  const segs = norm(path).replace(CODE_EXT, "").split("/").filter(Boolean);
  for (const seg of segs.slice(0, -1)) {
    const s = seg.toLowerCase();
    if (inner.includes(s)) return "inner";
    if (outer.includes(s)) return "outer";
  }
  return "other";
}

// Módulos importados por um arquivo Python (dotted). Cobre `import a.b`, `import a.b as c`, `import a, b`
// e `from a.b import x` (inclusive relativo `from ..a import x` — os pontos iniciais são removidos, o que
// resolve a camada de forma conservadora). Retorna o caminho do MÓDULO, não os símbolos importados. Puro.
export function parseImports(content: string): string[] {
  const mods: string[] = [];
  for (const raw of (content ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    const from = /^from\s+([.\w]+)\s+import\b/.exec(line);
    if (from) {
      const d = from[1].replace(/^\.+/, "").split(".").filter(Boolean).join(".");
      if (d) mods.push(d);
      continue;
    }
    const imp = /^import\s+(.+)$/.exec(line);
    if (imp) {
      for (const part of imp[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/i)[0].trim();
        const d = name.replace(/^\.+/, "").split(".").filter(Boolean).join(".");
        if (d) mods.push(d);
      }
    }
  }
  return mods;
}

// Normaliza um specifier de import TS/ES para a forma "dotted" que casa o SUFIXO do caminho de um arquivo
// gerado (ex.: './adapters/db' → "adapters.db"). SÓ imports RELATIVOS (./ ../) contam — um bare import
// ('react', '@scope/x') é dep de terceiros, nunca arquivo DESTE projeto → retorna null (nunca vira violação).
function normalizeTsSpecifier(spec: string): string | null {
  if (!spec.startsWith(".")) return null; // bare / @scope → terceiros
  const cleaned = (spec ?? "")
    .replace(/^(?:\.\/)+/, "") // ./x → x
    .replace(/^(?:\.\.\/)+/, "") // ../../x → x (o casamento é por SUFIXO — subir níveis não muda o alvo)
    .replace(/\/index$/i, "") // x/index → x
    .replace(CODE_EXT, "") // x.ts → x
    .replace(/\.js$/i, ""); // import '.../x.js' (ESM) → x
  const key = cleaned.split("/").filter(Boolean).join(".").toLowerCase();
  return key || null;
}

// Módulos importados por um arquivo TS/JS (ES import/export-from, side-effect import, require() e import()
// dinâmicos), na forma "dotted" e SÓ os relativos (ver normalizeTsSpecifier). Puro. Espelha parseImports
// (Python) para o gate de arquitetura em TypeScript.
export function parseImportsTs(content: string): string[] {
  const mods: string[] = [];
  const add = (spec: string) => {
    const m = normalizeTsSpecifier(spec);
    if (m) mods.push(m);
  };
  for (const raw of (content ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    // `import … from 'x'` / `export … from 'x'` (inclui `import type`, `export *`).
    const from = /^(?:import|export)\b[^'"]*\bfrom\s*['"]([^'"]+)['"]/.exec(line);
    if (from) {
      add(from[1]);
      continue;
    }
    // `import 'x'` (side-effect) — quote logo após import (distingue de `import('x')`).
    const side = /^import\s+['"]([^'"]+)['"]/.exec(line);
    if (side) {
      add(side[1]);
      continue;
    }
    // `require('x')` / `import('x')` dinâmicos — em qualquer posição da linha.
    for (const m of line.matchAll(/\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) add(m[1]);
  }
  return mods;
}

// Caminhos de import de um arquivo Go. Cobre `import "x"`, `import alias "x"` e o bloco `import ( ... )`
// com aliases (`m "x"`, import em branco `_ "x"`, dot-import `. "x"`) e comentários. Retorna o caminho do
// PACOTE cru (ex.: "example.com/mod/adapters/db"), com barras — o casamento por SUFIXO de DIRETÓRIO fica no
// findLayerViolations (o prefixo do módulo, vindo do go.mod, é desconhecido aqui). Puro. Espelha parseImports.
export function parseImportsGo(content: string): string[] {
  const mods: string[] = [];
  let inBlock = false;
  // Captura o "caminho" com um alias OPCIONAL antes das aspas (_, ., ou identificador). O regex é ANCORADO no
  // início da linha aparada, então captura só o PRIMEIRO literal — o texto de um comentário no fim da linha
  // (`"fmt" // legacy; was "x"`) é IGNORADO. NÃO dividimos a linha por `;`: embora `;` seja separador de
  // statements válido em Go (a forma `import ( "a"; "b" )` é real, mas exótica — o gofmt a reformata), dividir
  // por `;` fazia o texto de um comentário virar um import FABRICADO → falso-bloqueio (achado da 2ª passada
  // adversarial). Preferimos o fail-open: perder o 2º import de uma linha `;` (raríssimo) nunca fura a Regra de
  // Ouro; fabricar um import de um comentário, sim.
  const grab = (s: string) => {
    const m = /^(?:[A-Za-z_.]\w*\s+)?"([^"]+)"/.exec(s.trim());
    if (m) mods.push(m[1]);
  };
  for (const raw of (content ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (inBlock) {
      if (line.startsWith(")")) {
        inBlock = false;
        continue;
      }
      grab(line);
      continue;
    }
    const open = /^import\s*\(/.exec(line);
    if (open) {
      inBlock = true;
      const rest = line.slice(open[0].length).trim(); // suporta `import ( "x" )` numa linha só
      if (rest && !rest.startsWith(")")) grab(rest);
      if (rest.endsWith(")")) inBlock = false;
      continue;
    }
    const single = /^import\s+(?:[A-Za-z_.]\w*\s+)?"([^"]+)"/.exec(line);
    if (single) mods.push(single[1]);
  }
  return mods;
}

export interface LayerViolation {
  path: string; // arquivo da camada interna que viola
  imports: string[]; // os módulos externos importados (para a mensagem do gate)
}

// Detecta violações da regra de ouro: um arquivo INTERNO importando um módulo DESTE projeto na camada
// EXTERNA. CONSERVADOR (evita falso-positivo que bloquearia um arquivo legítimo): o import só conta quando
// resolve — por sufixo do caminho de módulo — para arquivo(s) gerado(s) e TODOS os que casam são "outer"
// (sem ambiguidade). Import externo/stdlib (sem arquivo gerado correspondente) é ignorado. Puro/testável.
export function findLayerViolations(files: { path: string; content: string }[], architecture: ProjectArchitecture, language: ProjectLanguage = "python"): LayerViolation[] {
  const inner = INNER[architecture];
  const outer = OUTER[architecture];
  // Go casa por DIRETÓRIO/pacote (um import Go aponta pro diretório, não pro arquivo) — caminho SEPARADO do
  // Python/TS para não regredir a lógica provada (lição do #113: reusar o layerCheck expôs um bug latente).
  if (language === "go") return findGoLayerViolations(files, inner, outer);
  const isTs = language === "typescript";
  const codeRe = isTs ? /\.[tj]sx?$/i : /\.py$/i; // Python-only ou TS/JS — outras linguagens não têm gate ainda
  const parse = isTs ? parseImportsTs : parseImports;
  const code = files.filter((f) => codeRe.test(f.path));

  // sufixo de módulo (ex.: "src.adapters.db", "adapters.db", "db") → conjunto de camadas dos arquivos que
  // esse import resolveria. Só marcamos violação quando o conjunto é EXATAMENTE {outer} (sem ambiguidade).
  const suffixLayers = new Map<string, Set<Layer>>();
  for (const f of code) {
    const lyr = layerOf(f.path, inner, outer);
    const segs = norm(f.path).replace(CODE_EXT, "").split("/").filter(Boolean);
    for (let i = 0; i < segs.length; i++) {
      const key = segs.slice(i).join(".").toLowerCase();
      const set = suffixLayers.get(key) ?? new Set<Layer>();
      set.add(lyr);
      suffixLayers.set(key, set);
    }
  }

  const out: LayerViolation[] = [];
  for (const f of code) {
    if (layerOf(f.path, inner, outer) !== "inner") continue;
    const bad = new Set<string>();
    for (const mod of parse(f.content)) {
      const layers = suffixLayers.get(mod.toLowerCase());
      if (layers && layers.size === 1 && layers.has("outer")) bad.add(mod);
    }
    if (bad.size) out.push({ path: norm(f.path), imports: [...bad] });
  }
  return out;
}

// Caminho do módulo declarado no go.mod entre os arquivos (o PREFIXO dos imports internos). Prefere o go.mod
// da RAIZ (menos segmentos). null se não houver go.mod parseável. Normaliza barras/caixa. Puro.
function goModulePath(files: { path: string; content: string }[]): string | null {
  const mods = files
    .filter((f) => /(^|\/)go\.mod$/i.test(norm(f.path)))
    .sort((a, b) => norm(a.path).split("/").length - norm(b.path).split("/").length);
  for (const m of mods) {
    const match = /^\s*module\s+(\S+)/m.exec(m.content ?? "");
    if (match) return match[1].replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  }
  return null;
}

// Variante Go da regra de camadas. Um import Go referencia um PACOTE = um DIRETÓRIO, com o caminho ANCORADO no
// prefixo do MÓDULO (go.mod). CHAVE (correção da revisão adversarial — Regra de Ouro): SÓ imports que começam
// com o prefixo do módulo são DESTE projeto — o análogo Go do filtro bare/@scope do ramo TS. O resto (stdlib,
// `github.com/…`, irmão de monorepo) é dep EXTERNA e NUNCA vira violação, mesmo que o segmento final coincida
// com o nome de um pacote OUTER gerado (o bug que o casamento por sufixo tinha: `github.com/acme/infra` casava
// `infra/`). O caminho relativo ao módulo é casado por IGUALDADE contra o diretório de um pacote gerado (sem
// sufixo parcial → sem colisão). Sem go.mod → sem violações (fail-open: sem o prefixo não dá para distinguir
// interno de terceiros). Puro/testável.
function findGoLayerViolations(files: { path: string; content: string }[], inner: string[], outer: string[]): LayerViolation[] {
  const code = files.filter((f) => /\.go$/i.test(f.path));
  const modulePrefix = goModulePath(files);
  if (!modulePrefix) return []; // sem o prefixo do módulo não dá para distinguir interno de terceiros → fail-open

  // diretório do pacote gerado (relativo à raiz do módulo, dot-joined, minúsculo) → camada.
  const pkgLayer = new Map<string, Layer>();
  for (const f of code) {
    const dir = norm(f.path).replace(/\.go$/i, "").split("/").filter(Boolean).slice(0, -1).join(".").toLowerCase();
    pkgLayer.set(dir, layerOf(f.path, inner, outer));
  }

  // Import interno → caminho de pacote relativo ao módulo (dot-joined); null se NÃO for deste módulo (terceiros/
  // stdlib/irmão de monorepo). É a guarda que fecha o falso-bloqueio.
  const internalPkg = (imp: string): string | null => {
    const p = imp.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    if (p === modulePrefix) return ""; // pacote raiz do módulo
    if (!p.startsWith(modulePrefix + "/")) return null; // dep externa
    return p.slice(modulePrefix.length + 1).split("/").filter(Boolean).join(".");
  };

  const out: LayerViolation[] = [];
  for (const f of code) {
    if (layerOf(f.path, inner, outer) !== "inner") continue;
    const bad = new Set<string>();
    for (const imp of parseImportsGo(f.content)) {
      const rel = internalPkg(imp);
      if (rel === null) continue; // dep externa → nunca é violação
      if (pkgLayer.get(rel) === "outer") bad.add(imp); // importa um pacote OUTER gerado DESTE módulo
    }
    if (bad.size) out.push({ path: norm(f.path), imports: [...bad] });
  }
  return out;
}
