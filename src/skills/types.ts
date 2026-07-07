export type SkillSource = "managed" | "user" | "workspace";

export interface SkillValidatorSpec {
  id: string;
  label: string;
  command: string; // pode conter o placeholder {file}
  gate: boolean; // RF-039: a falha bloqueia a aceitação do diff
  appliesTo?: string[]; // extensões de arquivo, ex.: [".py"]
}

// Nível 3 (P2 templates): um asset de SCAFFOLD que a skill materializa como forge-file (fora do LLM,
// determinístico). `src` é o caminho do .tmpl DENTRO do diretório da skill (confinado via loadAsset); `dest`
// é o caminho RELATIVO no workspace onde o arquivo é materializado. Ambos validados como relativos seguros.
export interface SkillTemplateSpec {
  src: string;
  dest: string;
}

export interface SkillFrontmatter {
  name: string;
  description: string;
  license?: string;
  metadata?: Record<string, unknown>;
  validators?: SkillValidatorSpec[];
  templates?: SkillTemplateSpec[];
}

export interface SkillMeta {
  name: string;
  description: string;
  path: string; // caminho absoluto para o diretório da skill
  source: SkillSource;
  enabled: boolean;
  validators: SkillValidatorSpec[];
  templates: SkillTemplateSpec[]; // P2: assets de scaffold declarados no frontmatter (podem ser [])
}

export interface FrontmatterError {
  field: string;
  message: string;
}
