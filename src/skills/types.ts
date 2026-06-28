export type SkillSource = "managed" | "user" | "workspace";

export interface SkillValidatorSpec {
  id: string;
  label: string;
  command: string; // pode conter o placeholder {file}
  gate: boolean; // RF-039: a falha bloqueia a aceitação do diff
  appliesTo?: string[]; // extensões de arquivo, ex.: [".py"]
}

export interface SkillFrontmatter {
  name: string;
  description: string;
  license?: string;
  metadata?: Record<string, unknown>;
  validators?: SkillValidatorSpec[];
}

export interface SkillMeta {
  name: string;
  description: string;
  path: string; // caminho absoluto para o diretório da skill
  source: SkillSource;
  enabled: boolean;
  validators: SkillValidatorSpec[];
}

export interface FrontmatterError {
  field: string;
  message: string;
}
