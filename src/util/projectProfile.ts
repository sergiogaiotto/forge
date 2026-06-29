// Perfil do projeto: um arquivo versionado (.forge/project.md) que captura papel, stack e
// convenções do time, injetado em TODO prompt (ver ContextAssembler) — para que correções como
// "nunca use emojis" virem regras duráveis em vez de serem re-digitadas a cada sessão.
//
// Este módulo é PURO (sem dependências de runtime) para teste unitário. O IO de arquivo fica no
// Controller, que chama estas funções.

export const PROFILE_RELPATH = ".forge/project.md";
const RULES_SECTION = "## Regras do projeto";

// Normaliza um texto de regra: tira marcador de bullet, colapsa espaços e limita o tamanho.
export function normalizeRule(raw: string): string {
  return (raw ?? "")
    .replace(/^\s*[-*]\s+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

// Anexa uma regra ao conteúdo do .forge/project.md, criando a seção (e o esqueleto) se faltar.
// Idempotente: não duplica uma regra já presente (comparação case-insensitive). Só ANEXA —
// nunca reescreve o que o dev editou à mão. Retorna o conteúdo igual ao original quando nada muda.
export function appendRule(existing: string | undefined, rawRule: string): string {
  const rule = normalizeRule(rawRule);
  if (!rule) return existing ?? "";
  const bullet = `- ${rule}`;
  const base = existing ?? "";

  const already = base.split("\n").some((l) => l.trim().toLowerCase() === bullet.toLowerCase());
  if (already) return base;

  if (!base.trim()) return defaultProfileSkeleton() + bullet + "\n";

  const idx = base.indexOf(RULES_SECTION);
  if (idx === -1) {
    const sep = base.endsWith("\n") ? "" : "\n";
    return `${base}${sep}\n${RULES_SECTION}\n${bullet}\n`;
  }
  // Insere logo após a linha do cabeçalho da seção (regras mais recentes no topo).
  const afterHeader = base.indexOf("\n", idx);
  if (afterHeader === -1) return `${base}\n${bullet}\n`;
  return base.slice(0, afterHeader + 1) + bullet + "\n" + base.slice(afterHeader + 1);
}

// Extrai as regras (bullets) da seção "## Regras do projeto" — para o painel do perfil.
export function parseRules(text: string | undefined): string[] {
  const base = text ?? "";
  const idx = base.indexOf(RULES_SECTION);
  if (idx === -1) return [];
  const after = base.slice(idx + RULES_SECTION.length);
  const out: string[] = [];
  for (const line of after.split("\n")) {
    const t = line.trim();
    if (t.startsWith("## ")) break; // próxima seção encerra
    const m = /^[-*]\s+(.+)$/.exec(t);
    if (m) out.push(m[1].trim());
  }
  return out;
}

// Agrega as regras de VÁRIOS perfis (admin/usuário/workspace), por documento, deduplicando
// (case-insensitive, preservando a ordem). parseRules sozinho é single-section — sobre o blob
// mesclado ele pararia na 2ª seção; por isso o painel deve agregar por documento, não no blob.
export function collectRules(bodies: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const b of bodies) {
    for (const r of parseRules(b)) {
      const k = r.toLowerCase();
      if (!seen.has(k)) {
        seen.add(k);
        out.push(r);
      }
    }
  }
  return out;
}

// Prepara o texto do perfil para injeção no prompt: trim + teto de tamanho (defensivo).
export function renderProfileBlock(text: string | undefined, maxChars = 4000): string {
  const t = (text ?? "").trim();
  if (!t) return "";
  return t.length > maxChars ? t.slice(0, maxChars) + "\n[perfil truncado por orçamento]" : t;
}

// Esqueleto inicial do arquivo, criado na primeira regra adicionada / ao abrir o perfil.
// A stack NÃO é gravada aqui de propósito: ela é detectada do repositório e injetada ao vivo a cada
// geração (sempre fresca, sem drift). Este arquivo é para o que o código não revela: papel e regras.
export function defaultProfileSkeleton(): string {
  return [
    "# Perfil do projeto (FORGE)",
    "",
    "Arquivo versionado e injetado em todo prompt do FORGE.",
    "A stack (linguagem, libs, lint/tipos/testes) é detectada automaticamente do repositório —",
    "use este arquivo para o papel, as bibliotecas preferidas e as convenções/regras do time.",
    "",
    RULES_SECTION,
    "",
  ].join("\n");
}
