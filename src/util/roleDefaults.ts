// Papel do desenvolvedor no projeto. Lido do .forge/project.md (frontmatter `papel:`) e expandido
// em uma orientação injetada no prompt, ajustando o ESTILO e os defaults do FORGE por papel.
// Puro/testável — o IO de arquivo fica no Controller.

export type Role = "cientista-de-dados" | "engenheiro-de-dados" | "engenheiro-de-ml" | "engenheiro-de-software";

// Normaliza variações de escrita para a chave canônica. Ordem importa: ML antes de DADOS para que
// "engenheiro de ml" não case com o padrão de dados.
export function normalizeRole(raw: string | undefined): Role | undefined {
  const t = (raw ?? "").trim().toLowerCase().replace(/[_\s]+/g, "-");
  if (!t) return undefined;
  if (/(cientista-?de-?dados|data-?scientist)/.test(t)) return "cientista-de-dados";
  if (/(engenheiro-?de-?ml|ml-?engineer|machine-?learning)/.test(t)) return "engenheiro-de-ml";
  if (/(engenheiro-?de-?dados|data-?engineer)/.test(t)) return "engenheiro-de-dados";
  if (/(engenheiro-?de-?software|software-?engineer|\bswe\b)/.test(t)) return "engenheiro-de-software";
  return undefined;
}

// Extrai o papel APENAS do frontmatter YAML de um perfil (não varre o corpo — uma linha de prosa/
// regra começando com `papel:` não conta). Retorna undefined se ausente/desconhecido.
export function parseRole(text: string | undefined): Role | undefined {
  const fm = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(text ?? "");
  const scope = fm ? fm[1] : "";
  const m = /^[ \t]*papel[ \t]*:[ \t]*["']?([^"'\n#]+?)["']?[ \t]*$/im.exec(scope);
  return m ? normalizeRole(m[1]) : undefined;
}

// Resolve o papel a partir de múltiplos perfis na ordem dada (usuário → workspace): o ÚLTIMO que
// declarar um papel vence, honrando a precedência "o workspace tem a palavra final".
export function resolveRole(texts: string[]): Role | undefined {
  let role: Role | undefined;
  for (const t of texts) {
    const r = parseRole(t);
    if (r) role = r;
  }
  return role;
}

const GUIDANCE: Record<Role, string> = {
  "cientista-de-dados":
    "Cientista de Dados — priorize fluxo exploratório e notebooks (.ipynb / `# %%`), pandas/numpy/scikit-learn, visualização inline e reprodutibilidade do experimento; explique premissas e a leitura dos resultados.",
  "engenheiro-de-dados":
    "Engenheiro de Dados — priorize pipelines idempotentes e determinísticos, contratos/esquemas explícitos, tratamento de nulos/tipos/duplicados, particionamento e Spark/SQL; evite efeitos colaterais, código pronto para orquestração.",
  "engenheiro-de-ml":
    "Engenheiro de ML — priorize reprodutibilidade (seeds, versionamento de dados/modelo), rastreio de experimentos, separação treino/serving, métricas e validação, e latência/custo de inferência.",
  "engenheiro-de-software":
    "Engenheiro de Software — priorize testes (de preferência primeiro), tipos estáticos, fronteiras/SOLID, tratamento de erros explícito e APIs claras; evite acoplamento desnecessário.",
};

const LABELS: Record<Role, string> = {
  "cientista-de-dados": "Cientista de dados",
  "engenheiro-de-dados": "Engenheiro de dados",
  "engenheiro-de-ml": "Engenheiro de ML",
  "engenheiro-de-software": "Engenheiro de software",
};

// Rótulo legível do papel (para o painel/notices).
export function roleLabel(role: Role): string {
  return LABELS[role];
}

export function roleGuidance(role: Role | undefined): string {
  if (!role) return "";
  return `## Papel e padrões (oriente o estilo e os defaults por este papel)\n- ${GUIDANCE[role]}`;
}

// Remove o frontmatter YAML inicial do corpo do perfil (os campos estruturados viram orientação;
// o corpo/regras é o que injetamos como prosa).
export function stripFrontmatter(text: string | undefined): string {
  return (text ?? "").replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/, "").trim();
}

// Grava/atualiza o `papel:` no frontmatter do perfil (cria o frontmatter se faltar). Só mexe no
// frontmatter — nunca reescreve o corpo editado pelo dev. Reconstrói por ÍNDICES (não por
// String.replace) para não interpretar `$`/`$&` do conteúdo do dev nem quebrar com bloco vazio, e
// preserva o fim-de-linha (LF/CRLF) do arquivo.
export function setRole(text: string | undefined, role: Role): string {
  const base = text ?? "";
  const m = /^(---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*\r?\n?)/.exec(base);
  if (m) {
    const [full, open, inner, close] = m;
    const eol = /\r\n/.test(full) ? "\r\n" : "\n";
    let newInner: string;
    if (/^[ \t]*papel[ \t]*:/im.test(inner)) {
      newInner = inner.replace(/^[ \t]*papel[ \t]*:.*$/im, `papel: ${role}`);
    } else if (inner.trim() === "") {
      newInner = `papel: ${role}`;
    } else {
      newInner = inner.replace(/[ \t\r\n]*$/, "") + `${eol}papel: ${role}`;
    }
    return base.slice(0, m.index) + open + newInner + close + base.slice(m.index + full.length);
  }
  return `---\npapel: ${role}\n---\n\n${base}`;
}
