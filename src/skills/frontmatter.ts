import * as yaml from "js-yaml";
import { FrontmatterError, SkillFrontmatter, SkillTemplateSpec, SkillValidatorSpec } from "./types";

const FM_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/;
const NAME_RE = /^[a-z0-9-]{1,64}$/;

export interface ParsedSkill {
  frontmatter: SkillFrontmatter;
  body: string;
}

export interface ParseResult {
  ok: boolean;
  parsed?: ParsedSkill;
  errors: FrontmatterError[];
}

// RF-031: valida `name` (1–64, [a-z0-9-], == nome do diretório) e
// `description` (1–1024). Rejeita `<`/`>` no frontmatter (proteção contra
// prompt-injection / markup).
export function parseSkill(content: string, dirName?: string): ParseResult {
  const errors: FrontmatterError[] = [];
  const match = FM_RE.exec(content.replace(/^﻿/, ""));
  if (!match) {
    return { ok: false, errors: [{ field: "frontmatter", message: "Frontmatter YAML (--- … ---) ausente." }] };
  }
  const [, fmRaw, body] = match;

  let doc: Record<string, unknown>;
  try {
    doc = (yaml.load(fmRaw) as Record<string, unknown>) ?? {};
  } catch (e) {
    return { ok: false, errors: [{ field: "frontmatter", message: `YAML inválido: ${(e as Error).message}` }] };
  }
  if (typeof doc !== "object" || Array.isArray(doc)) {
    return { ok: false, errors: [{ field: "frontmatter", message: "Frontmatter deve ser um mapa YAML." }] };
  }

  const name = typeof doc.name === "string" ? doc.name.trim() : "";
  const description = typeof doc.description === "string" ? doc.description.trim() : "";

  // RF-031: rejeita `<`/`>` nos VALORES de string injetados (proteção contra
  // markup/injection). Isto é aplicado após o parsing do YAML para que indicadores
  // legítimos de bloco escalar do YAML (`>-`, `>`) não sejam confundidos com sinais de menor/maior.
  if (/[<>]/.test(name) || /[<>]/.test(description)) {
    errors.push({ field: "frontmatter", message: "Caracteres '<' ou '>' não são permitidos em name/description." });
  }

  if (!NAME_RE.test(name)) {
    errors.push({ field: "name", message: "name deve ter 1–64 chars em [a-z0-9-]." });
  }
  if (dirName && name && name !== dirName) {
    errors.push({ field: "name", message: `name "${name}" deve ser igual ao nome do diretório "${dirName}".` });
  }
  if (description.length < 1 || description.length > 1024) {
    errors.push({ field: "description", message: "description deve ter 1–1024 chars." });
  }

  const validators = parseValidators(doc.validators, errors);
  const templates = parseTemplates(doc.templates, errors);

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    errors: [],
    parsed: {
      frontmatter: {
        name,
        description,
        license: typeof doc.license === "string" ? doc.license : undefined,
        metadata: isRecord(doc.metadata) ? doc.metadata : undefined,
        validators,
        templates,
      },
      body: body ?? "",
    },
  };
}

// Um caminho de template (src DENTRO da skill / dest no workspace) só é aceito se for RELATIVO e SEGURO:
// não-vazio, sem ser absoluto (sem `/`/`\` inicial nem drive `C:`), e sem NENHUM segmento `..` (traversal).
// Isto é defesa em profundidade — o loadAsset ainda confina o src ao dir da skill e o safeWorkspacePath ainda
// contém o dest no apply — mas rejeitar cedo dá erro claro e evita materializar caminho perigoso. Puro.
export function isSafeRelPath(p: string): boolean {
  const s = (p ?? "").trim();
  if (!s) return false;
  if (/^([a-zA-Z]:[\\/]|[\\/])/.test(s)) return false; // absoluto (drive ou raiz)
  const segs = s.replace(/\\/g, "/").split("/");
  if (segs.some((seg) => seg === "..")) return false; // traversal
  return true;
}

// P2 (templates): parseia `templates: [{ src, dest }]`. Cada item exige `src`/`dest` string e ambos SEGUROS
// (isSafeRelPath) — senão vira erro de frontmatter (a skill é rejeitada, como um validador malformado).
function parseTemplates(raw: unknown, errors: FrontmatterError[]): SkillTemplateSpec[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    errors.push({ field: "templates", message: "templates deve ser uma lista." });
    return [];
  }
  const out: SkillTemplateSpec[] = [];
  raw.forEach((item, i) => {
    if (!isRecord(item) || typeof item.src !== "string" || typeof item.dest !== "string") {
      errors.push({ field: `templates[${i}]`, message: "cada template exige src e dest (strings)." });
      return;
    }
    if (!isSafeRelPath(item.src) || !isSafeRelPath(item.dest)) {
      errors.push({ field: `templates[${i}]`, message: "src e dest devem ser caminhos relativos seguros (sem '..' nem absoluto)." });
      return;
    }
    out.push({ src: item.src.trim(), dest: item.dest.trim() });
  });
  return out;
}

function parseValidators(raw: unknown, errors: FrontmatterError[]): SkillValidatorSpec[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    errors.push({ field: "validators", message: "validators deve ser uma lista." });
    return [];
  }
  const out: SkillValidatorSpec[] = [];
  raw.forEach((item, i) => {
    if (!isRecord(item) || typeof item.command !== "string" || typeof item.id !== "string") {
      errors.push({ field: `validators[${i}]`, message: "cada validador exige id e command." });
      return;
    }
    out.push({
      id: item.id,
      label: typeof item.label === "string" ? item.label : item.id,
      command: item.command,
      gate: item.gate === true,
      appliesTo: Array.isArray(item.appliesTo) ? (item.appliesTo as string[]) : undefined,
    });
  });
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
