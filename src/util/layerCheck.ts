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
