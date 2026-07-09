// I/O do grounding dbt: localiza o projeto (dbt_project.yml na raiz do workspace ou 1 nível abaixo),
// resolve o target-path e carrega manifest.json (+ catalog.json quando existir) para o DbtIndex.
// Cache por mtime: re-stat é barato e mantém o índice fresco após um `dbt compile` sem reindexação
// manual. Fail-open em TUDO: sem projeto/artefato/JSON válido → null (as camadas acima degradam).
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DbtIndex, parseDbtArtifacts } from "./artifacts";

// `warn` injetável (padrão do EgressEnforcer): módulo testável em Node puro, sem importar vscode.
type WarnFn = (message: string, err?: unknown) => void;

export interface DbtProjectLocation {
  projectDir: string; // diretório com dbt_project.yml (absoluto)
  targetDir: string; // diretório dos artefatos (absoluto)
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// target-path do dbt_project.yml (linha `target-path: "algo"`), default "target".
export function parseTargetPath(dbtProjectYml: string): string {
  const m = /^\s*target-path\s*:\s*["']?([^"'\r\n#]+)["']?\s*$/m.exec(dbtProjectYml ?? "");
  return (m?.[1] ?? "target").trim() || "target";
}

// Procura o projeto dbt: raiz do workspace, depois 1 nível de subdiretórios (monorepos costumam ter
// o dbt em transform/ ou dbt/). O primeiro encontrado vence — múltiplos projetos ficam para depois.
export async function findDbtProject(workspaceRoot: string): Promise<DbtProjectLocation | null> {
  const candidates: string[] = [workspaceRoot];
  try {
    const entries = await fs.readdir(workspaceRoot, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") {
        candidates.push(path.join(workspaceRoot, e.name));
      }
    }
  } catch {
    return null;
  }
  for (const dir of candidates) {
    const yml = path.join(dir, "dbt_project.yml");
    if (!(await exists(yml))) continue;
    let targetPath = "target";
    try {
      targetPath = parseTargetPath(await fs.readFile(yml, "utf8"));
    } catch {
      // segue com o default
    }
    return { projectDir: dir, targetDir: path.resolve(dir, targetPath) };
  }
  return null;
}

export interface LoadedDbtIndex {
  index: DbtIndex;
  location: DbtProjectLocation;
  manifestMtimeMs: number;
  catalogMtimeMs: number; // 0 quando não há catalog.json
}

export async function loadDbtIndex(location: DbtProjectLocation, warn: WarnFn = () => undefined): Promise<LoadedDbtIndex | null> {
  const manifestPath = path.join(location.targetDir, "manifest.json");
  const catalogPath = path.join(location.targetDir, "catalog.json");
  let manifestStat;
  try {
    manifestStat = await fs.stat(manifestPath);
  } catch {
    return null; // sem manifest, sem grounding — o dev ainda não rodou dbt parse/compile
  }
  try {
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as unknown;
    let catalog: unknown;
    let catalogMtimeMs = 0;
    try {
      const catStat = await fs.stat(catalogPath);
      catalog = JSON.parse(await fs.readFile(catalogPath, "utf8")) as unknown;
      catalogMtimeMs = catStat.mtimeMs;
    } catch {
      // catalog é opcional (só existe após dbt docs generate)
    }
    return { index: parseDbtArtifacts(manifest, catalog), location, manifestMtimeMs: manifestStat.mtimeMs, catalogMtimeMs };
  } catch (err) {
    warn("dbt: manifest.json ilegível — grounding desativado até o próximo dbt compile.", err);
    return null;
  }
}

// Os artefatos em disco mudaram desde o carregamento? (re-stat barato; erro → true = recarrega)
export async function dbtIndexStale(loaded: LoadedDbtIndex): Promise<boolean> {
  try {
    const m = await fs.stat(path.join(loaded.location.targetDir, "manifest.json"));
    if (m.mtimeMs !== loaded.manifestMtimeMs) return true;
    const catalogPath = path.join(loaded.location.targetDir, "catalog.json");
    try {
      const c = await fs.stat(catalogPath);
      return c.mtimeMs !== loaded.catalogMtimeMs;
    } catch {
      return loaded.catalogMtimeMs !== 0;
    }
  } catch {
    return true;
  }
}
