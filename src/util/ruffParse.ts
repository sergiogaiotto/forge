// Gate de IMPORTS MORTOS (F-18): o código gerado pode compilar, tipar e estar "pronto" e ainda carregar
// imports NÃO USADOS (ruído que confunde o dev e vaza dependências fantasmas). O ruff (regra F401) os
// reconhece por AST (não EXECUTA o código). Este módulo é PURO: parseia o relatório JSON do ruff em achados
// ADVISORY. SEMPRE consultivo — nunca bloqueia (não há modo conservador, ao contrário do bandit).

export interface RuffFinding {
  path: string;
  line: number;
  code: string; // ex.: "F401"
  message: string; // ex.: "`os` imported but unused"
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
    // O ruff emite os erros de SINTAXE do parser SEMPRE (com `code: null`), mesmo sob `--select F401` —
    // esses NÃO são imports mortos (o compileall/mypy já os pega) e virariam ruído rotulado errado. Fica só
    // o F401. Um relatório só com sintaxe → [] (rodou, 0 imports mortos), distinto de null (não rodou).
    const code = String(r?.code ?? "").trim();
    if (code !== "F401") continue;
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
