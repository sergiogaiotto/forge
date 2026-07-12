// Gate de PYFLAKES via ruff (F-18 + #9): o código gerado pode compilar, tipar e estar "pronto" e ainda ter
// bugs que o compileall (só SINTAXE) e o mypy (só TIPO, e best-effort) não pegam. O ruff os reconhece por AST
// (não EXECUTA o código) e roda mesmo sem as deps instaladas (leve, mais provável de estar presente que o
// mypy). Este módulo é PURO: parseia o relatório JSON do ruff em achados ADVISORY. SEMPRE consultivo —
// nunca bloqueia (a promoção do F821 a bloqueante é follow-up, só após empíria zero-falso-positivo).
//
// Códigos gateados (#9 amplia de só-F401 para a família de "referência-fantasma" + f-string quebrada):
//  F401 import não usado · F811 redefinição de nome não usado · F821 NOME INDEFINIDO (o análogo Python do
//  TS2304 — símbolo-fantasma que o compileall não vê) · F822 nome indefinido em __all__ · F823 variável
//  local usada antes de atribuir · F501-F509 erro de %-format · F521-F525 erro de .format().
// F821/F822/F823 são confiáveis SEM deps: o ruff vê o `import` (não flagra símbolo importado) e um star-import
// (`from x import *`) DESLIGA o F821 (conservador) — só o nome genuinamente fantasma acusa.
export const RUFF_GATE_CODES = [
  "F401", "F811", "F821", "F822", "F823",
  "F501", "F502", "F503", "F504", "F505", "F506", "F507", "F508", "F509",
  "F521", "F522", "F523", "F524", "F525",
];
const RUFF_GATE_SET = new Set(RUFF_GATE_CODES);

export interface RuffFinding {
  path: string;
  line: number;
  code: string; // ex.: "F401", "F821"
  message: string; // ex.: "`os` imported but unused", "Undefined name `Foo`"
}

// Extrai o ARRAY JSON do relatório do ruff (`--output-file`), que é um ARRAY no topo (diferente do bandit,
// que é {results:[...]}). Parse do texto inteiro resolve o caso normal; o recorte do primeiro `[` ao último
// `]` é só defesa contra ruído a montante. Strip de BOM. Falha / não-array → null (fail-open no chamador).
function extractJsonArray(raw: string): unknown[] | null {
  const s = (raw ?? "").replace(/^﻿/, "").trim();
  if (!s) return null;
  try {
    const doc = JSON.parse(s);
    return Array.isArray(doc) ? doc : null;
  } catch {
    /* defensivo: recorta do primeiro [ ao último ] */
  }
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  try {
    const doc = JSON.parse(s.slice(start, end + 1));
    return Array.isArray(doc) ? doc : null;
  } catch {
    return null;
  }
}

// Parseia o relatório do ruff num vetor de achados. Distingue TRÊS estados (crucial para NÃO tratar um
// relatório ausente/truncado como "0 achados"): `null` quando NÃO há relatório-array válido (ruff não rodou /
// crashou / arquivo truncado) — o chamador degrada para fail-open; `[]` quando rodou e nada achou; `[...]`
// com os achados. PURO. Nunca lança. (O exit code do ruff é 1 quando ACHA algo — normal; o veredito vem
// SEMPRE do relatório, nunca do exit code.)
export function parseRuffReport(raw: string): RuffFinding[] | null {
  const arr = extractJsonArray(raw);
  if (arr === null) return null; // sem relatório-array válido → indisponível (fail-open)
  const out: RuffFinding[] = [];
  for (const r of arr as any[]) {
    const path = String(r?.filename ?? "").trim();
    if (!path) continue;
    // O ruff emite os erros de SINTAXE do parser SEMPRE (com `code: null`), mesmo com --select restrito —
    // esses NÃO são achados de Pyflakes (o compileall/mypy já os pegam) e virariam ruído rotulado errado.
    // Fica só o set gateado (RUFF_GATE_CODES). Um relatório só com sintaxe → [] (rodou, 0 achados gateados),
    // distinto de null (não rodou).
    const code = String(r?.code ?? "").trim();
    if (!RUFF_GATE_SET.has(code)) continue;
    out.push({
      path,
      line: Number(r?.location?.row) || 0,
      code,
      message: String(r?.message ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
    });
  }
  return out;
}

// Linhas legíveis (advisory) dos achados, ordenadas de forma estável. Mesmo formato do securityAdvisories do
// bandit (`path:line — ...`) para o DevPanel renderizá-las identicamente. Os paths já vêm NORMALIZADOS pelo
// chamador (o ruff emite caminhos ABSOLUTOS; o Controller os converte para relativos à raiz do gate).
export function ruffAdvisories(findings: RuffFinding[]): string[] {
  return findings.map((f) => `${f.path}:${f.line} — ruff ${f.code}: ${f.message}`).sort();
}

// Códigos PROMOVIDOS a BLOQUEANTE (família de NOME-INDEFINIDO / símbolo-fantasma — o análogo Python do
// TS2307 que já bloqueia no #05). Validado por empíria exaustiva AO VIVO (ruff 0.8.4, 6 categorias de código
// gerado): F821 (nome indefinido) NÃO acusa star-import/forward-ref/TYPE_CHECKING/import-condicional/def-tardia;
// F822 (nome indefinido em __all__) e F823 (var local usada antes de atribuir) são drift real do mesmo eixo.
// O resto (F401 import morto, F811 redefinição, F5xx f-string) segue ADVISORY.
export const RUFF_BLOCKING_CODES = new Set(["F821", "F822", "F823"]);

// Separa os achados do ruff em BLOQUEANTES (agrupados por arquivo, como o splitSecurityFindings do bandit —
// entram em gate.fileErrors e fecham o Aplicar) e ADVISORY (o resto). Puro. Fora do auto-reparo, como a
// segurança/arquitetura: um símbolo-fantasma é bug que o dev/regeneração corrige, não o reparo de type-drift.
export function splitRuffFindings(findings: RuffFinding[]): { blocking: { path: string; errors: string[] }[]; advisories: string[] } {
  const byPath = new Map<string, string[]>();
  const advisoryFindings: RuffFinding[] = [];
  for (const f of findings) {
    if (RUFF_BLOCKING_CODES.has(f.code)) {
      const arr = byPath.get(f.path) ?? [];
      arr.push(`linha ${f.line}: [${f.code}] ${f.message}`);
      byPath.set(f.path, arr);
    } else {
      advisoryFindings.push(f);
    }
  }
  const blocking = [...byPath.entries()].map(([path, errors]) => ({ path, errors })).sort((a, b) => a.path.localeCompare(b.path));
  return { blocking, advisories: ruffAdvisories(advisoryFindings) };
}
