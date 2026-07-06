// Gate de ARQUITETURA (P2): a "regra de ouro" das arquiteturas que apontam para dentro — a camada INTERNA
// (domínio/entidades/model) NÃO pode importar a camada EXTERNA (adapters/infra/repository/controllers). O
// mypy/compileall não pega isso: um domínio importando adapters compila e tipa, mas quebra a arquitetura
// que o dev escolheu. Este módulo é a fitness function (estilo import-linter/ArchUnit) — PURO/testável; o
// Controller.runProjectGate a materializa num GateCheckResult que bloqueia o Aplicar do arquivo violador.
import { ProjectArchitecture } from "../shared/protocol";

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
function layerOf(path: string, inner: string[], outer: string[]): Layer {
  for (const seg of norm(path).replace(/\.py$/i, "").split("/")) {
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

export interface LayerViolation {
  path: string; // arquivo da camada interna que viola
  imports: string[]; // os módulos externos importados (para a mensagem do gate)
}

// Detecta violações da regra de ouro: um arquivo INTERNO importando um módulo DESTE projeto na camada
// EXTERNA. CONSERVADOR (evita falso-positivo que bloquearia um arquivo legítimo): o import só conta quando
// resolve — por sufixo do caminho de módulo — para arquivo(s) gerado(s) e TODOS os que casam são "outer"
// (sem ambiguidade). Import externo/stdlib (sem arquivo gerado correspondente) é ignorado. Puro/testável.
export function findLayerViolations(files: { path: string; content: string }[], architecture: ProjectArchitecture): LayerViolation[] {
  const inner = INNER[architecture];
  const outer = OUTER[architecture];
  const py = files.filter((f) => /\.py$/i.test(f.path));

  // sufixo de módulo (ex.: "src.adapters.db", "adapters.db", "db") → conjunto de camadas dos arquivos que
  // esse import resolveria. Só marcamos violação quando o conjunto é EXATAMENTE {outer} (sem ambiguidade).
  const suffixLayers = new Map<string, Set<Layer>>();
  for (const f of py) {
    const lyr = layerOf(f.path, inner, outer);
    const segs = norm(f.path).replace(/\.py$/i, "").split("/").filter(Boolean);
    for (let i = 0; i < segs.length; i++) {
      const key = segs.slice(i).join(".").toLowerCase();
      const set = suffixLayers.get(key) ?? new Set<Layer>();
      set.add(lyr);
      suffixLayers.set(key, set);
    }
  }

  const out: LayerViolation[] = [];
  for (const f of py) {
    if (layerOf(f.path, inner, outer) !== "inner") continue;
    const bad = new Set<string>();
    for (const mod of parseImports(f.content)) {
      const layers = suffixLayers.get(mod.toLowerCase());
      if (layers && layers.size === 1 && layers.has("outer")) bad.add(mod);
    }
    if (bad.size) out.push({ path: norm(f.path), imports: [...bad] });
  }
  return out;
}
