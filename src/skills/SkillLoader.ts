import * as fs from "node:fs/promises";
import * as path from "node:path";
import { log } from "../util/logger";
import { parseSkill } from "./frontmatter";
import { SkillMeta, SkillSource } from "./types";

export interface SkillRoot {
  path: string;
  source: SkillSource;
}

// RF-030/038: descobre skills entre as roots (admin-managed, user-global,
// workspace e `.claude/skills/`). Cada subdiretório imediato contendo um
// SKILL.md válido é indexado. Skills inválidas são registradas em log e ignoradas.
export class SkillLoader {
  async discover(roots: SkillRoot[]): Promise<SkillMeta[]> {
    const seen = new Map<string, SkillMeta>(); // name -> meta (roots posteriores sobrescrevem por precedência)
    for (const root of roots) {
      const metas = await this.scanRoot(root);
      for (const m of metas) {
        // Precedência: workspace > user > managed (roots posteriores vencem se passadas por último).
        seen.set(m.name, m);
      }
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private async scanRoot(root: SkillRoot): Promise<SkillMeta[]> {
    let entries: string[];
    try {
      const dirents = await fs.readdir(root.path, { withFileTypes: true });
      entries = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return []; // a root não existe — tudo bem
    }
    const out: SkillMeta[] = [];
    for (const dir of entries) {
      const skillDir = path.join(root.path, dir);
      const skillFile = path.join(skillDir, "SKILL.md");
      let content: string;
      try {
        content = await fs.readFile(skillFile, "utf8");
      } catch {
        continue; // sem SKILL.md → ignora (RF-030)
      }
      const result = parseSkill(content, dir);
      if (!result.ok || !result.parsed) {
        log.warn(`Skill inválida em ${skillDir}: ${result.errors.map((e) => `${e.field}: ${e.message}`).join("; ")}`);
        continue;
      }
      out.push({
        name: result.parsed.frontmatter.name,
        description: result.parsed.frontmatter.description,
        path: skillDir,
        source: root.source,
        enabled: true,
        validators: result.parsed.frontmatter.validators ?? [],
        templates: result.parsed.frontmatter.templates ?? [],
      });
    }
    return out;
  }

  // Nível 2 (ativação): carrega o corpo completo do SKILL.md sob demanda (RF-033).
  async loadBody(meta: SkillMeta): Promise<string> {
    const content = await fs.readFile(path.join(meta.path, "SKILL.md"), "utf8");
    const result = parseSkill(content, path.basename(meta.path));
    return result.parsed?.body ?? "";
  }

  // Nível 3 (execução): carrega um asset auxiliar sob demanda (RF-034). O path é
  // confinado ao diretório da skill.
  async loadAsset(meta: SkillMeta, relPath: string): Promise<Buffer> {
    const resolved = path.resolve(meta.path, relPath);
    if (!resolved.startsWith(path.resolve(meta.path) + path.sep)) {
      throw new Error(`Acesso fora do diretório da skill negado: ${relPath}`);
    }
    return fs.readFile(resolved);
  }
}
