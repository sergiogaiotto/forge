// P2 (nível 3 / templates): materialização DETERMINÍSTICA de assets de scaffold declarados no frontmatter da
// skill como forge-file — FORA do LLM. Ver a nota do roadmap: injetar o template no prompt ≠ determinismo; o
// scaffold determinístico vem de MATERIALIZAR o .tmpl como proposta (que então herda o gate e o "Aplicar").
// Este módulo é PURO/testável: interpolação + plano de materialização (colisão/normalização). O I/O (loadAsset
// do conteúdo cru + registerManualProposal) fica no Controller.
import { SkillTemplateSpec } from "./types";

// Interpola `{{chave}}` (tolera espaços: `{{ chave }}`) para as vars de um WHITELIST. Uma chave AUSENTE das
// vars é deixada INTACTA (não some, não quebra) — determinístico e sem eval (só substituição de string). O
// Controller passa só vars seguras (projectName/projectSlug/language/architecture), então não há injeção.
export function interpolateTemplate(content: string, vars: Record<string, string>): string {
  return (content ?? "").replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match
  );
}

// Deriva um IDENTIFICADOR seguro (^[a-z_]\w*$) de um nome livre (ex.: o nome da pasta do workspace). O nome
// cru vira CHAVE/valor em arquivos de config (dbt name/profile, chave de models) — e nomes de pasta reais no
// Windows têm espaço/hífen/ponto/#/apóstrofo, que ou quebram o YAML ou reprovam a regra de nome do dbt. Este
// slug determinístico (fora do LLM) evita isso: minúsculas, não-[a-z0-9_] → "_", colapsa "_", tira das pontas,
// prefixa "_" se começar com dígito, e cai para "forge_project" se degenerar a vazio. Puro/testável.
export function toIdentifierSlug(name: string): string {
  const s = (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!s) return "forge_project";
  return /^[0-9]/.test(s) ? "_" + s : s;
}

export interface PlannedTemplate {
  src: string; // caminho do .tmpl na skill (proveniência, para a mensagem)
  dest: string; // caminho no workspace (interpolado + normalizado)
  content: string; // conteúdo já interpolado
  status: "materialize" | "collision"; // "collision" = o dest já é uma proposta (do LLM ou de outro template)
}

// Planeja a materialização dos templates de uma skill: interpola conteúdo E dest, normaliza o dest e decide
// GAP-FILL — só materializa se o dest ainda NÃO existe entre as propostas (do LLM ou de um template anterior).
// Nunca sobrescreve o que o LLM gerou (zero conflito). `existingDests` vem JÁ normalizado pelo chamador; `norm`
// é o normalizador de caminho (o mesmo do gate, normGatePath) — injetado para manter este módulo desacoplado do
// core. `caseFold` alinha a comparação de colisão à semântica REAL do FS (o chamador passa true em Windows/macOS,
// case-insensitive, e false no Linux, case-sensitive) — casando o `existsSync` do gap-fill de disco: em FS
// case-insensitive `Foo.yml`/`foo.yml` são o MESMO arquivo (colide, senão sobrescreveria); no Linux são distintos
// (não colide). Case-fold só na comparação — o normGatePath preserva a caixa (necessária no path-matching do
// compileall). Default true = conservador (Windows-safe). Puro/testável.
export function planTemplateFiles(
  loaded: { spec: SkillTemplateSpec; raw: string }[],
  vars: Record<string, string>,
  existingDests: Set<string>,
  norm: (p: string) => string,
  caseFold = true
): PlannedTemplate[] {
  const fold = (s: string) => (caseFold ? s.toLowerCase() : s);
  const existKeys = new Set([...existingDests].map(fold));
  const planned = new Set<string>(); // chaves já planejadas NESTA passada (dedup entre templates)
  const out: PlannedTemplate[] = [];
  for (const { spec, raw } of loaded) {
    const dest = norm(interpolateTemplate(spec.dest, vars));
    if (!dest) continue; // dest degenerou para vazio após interpolação/normalização → ignora
    const key = fold(dest);
    const content = interpolateTemplate(raw, vars);
    const collision = existKeys.has(key) || planned.has(key);
    planned.add(key);
    out.push({ src: spec.src, dest, content, status: collision ? "collision" : "materialize" });
  }
  return out;
}
