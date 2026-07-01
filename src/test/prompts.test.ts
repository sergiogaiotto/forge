import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBasePrompt, buildContinuationPrompt, buildProjectPrompt, buildReviewPrompt, buildTailContinuation, buildTddPrompt } from "../core/systemPrompt";

test("prompt TDD inclui o prompt base e instruções de test-first", () => {
  const p = buildTddPrompt("meu-projeto");
  assert.ok(p.includes("FORGE"));
  assert.ok(p.includes("meu-projeto"));
  assert.match(p, /MODO TDD/);
  assert.match(p, /pytest/);
  assert.match(p, /test_/);
  // mantém o protocolo de edição de arquivos do prompt base
  assert.ok(p.includes("forge-file"));
});

test("prompt de revisão é multi-lente e em pt-BR", () => {
  const p = buildReviewPrompt();
  assert.match(p, /FORGE Review/);
  assert.match(p, /Segurança/);
  assert.match(p, /LGPD/);
  assert.match(p, /severidade/);
  assert.match(p, /pt-BR/);
});

test("prompt base exige pt-BR", () => {
  assert.match(buildBasePrompt("x"), /pt-BR/);
});

test("prompt base proíbe elipses/omissões para forçar o arquivo completo", () => {
  const p = buildBasePrompt("x");
  assert.match(p, /PROIBIDO/);
  assert.match(p, /restante do código/); // veta o placeholder exato observado no print
  assert.match(p, /linha por linha/);
});

test("prompt de revisão também proíbe omissões no bloco corrigido", () => {
  const p = buildReviewPrompt();
  // mesma regra compartilhada (NO_ELLIPSIS_RULE) que o prompt base
  assert.match(p, /PROIBIDO/);
  assert.match(p, /restante do código/);
});

test("buildContinuationPrompt cita o arquivo, manda continuar e proíbe reabrir a cerca", () => {
  const p = buildContinuationPrompt("src/a.py");
  assert.match(p, /src\/a\.py/);
  assert.match(p, /CONTINUE/);
  assert.match(p, /NÃO reabra/i);
  assert.match(p, /PROIBIDO|reticências/i); // herda o NO_ELLIPSIS_RULE
});

test("buildProjectPrompt (Python/hexagonal): linguagem, camadas, protocolo forge-file, manifesto e anti-elipse", () => {
  const p = buildProjectPrompt("proj", "python", "hexagonal");
  assert.match(p, /Python/);
  assert.match(p, /hexagonal/i);
  assert.match(p, /forge-file/);
  assert.match(p, /domain/);
  assert.match(p, /ports/);
  assert.match(p, /Protocol|ABC/); // mecanismo de interface do Python
  assert.match(p, /pyproject|requirements/i); // manifesto
  assert.match(p, /TESTES/); // pede testes por camada
  assert.match(p, /PROIBIDO|reticências/i); // NO_ELLIPSIS_RULE
});

test("buildTailContinuation: manda emitir o restante dos arquivos, sem repetir nem reabrir bloco", () => {
  const p = buildTailContinuation();
  assert.match(p, /CONTINUE/);
  assert.match(p, /restante|próximos arquivos/i);
  assert.match(p, /NÃO reabra/i);
});

test("buildProjectPrompt ajusta arquitetura, manifesto e interface por linguagem", () => {
  const go = buildProjectPrompt("p", "go", "clean");
  assert.match(go, /\bGo\b/);
  assert.match(go, /clean/i);
  assert.match(go, /interface Go/);
  assert.match(go, /go\.mod/);
  const ts = buildProjectPrompt("p", "typescript", "mvc");
  assert.match(ts, /MVC/i);
  assert.match(ts, /package\.json/);
});
