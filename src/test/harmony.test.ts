import assert from "node:assert/strict";
import { test } from "node:test";
import { stripHarmony } from "../util/harmony";

test("stripHarmony: canal final delimitado — mantém só o conteúdo após <|channel|>final<|message|>", () => {
  const leak = "Now final output is markdown string. Proceed.<|channel|>final<|message|># Título\nconteúdo real";
  assert.equal(stripHarmony(leak), "# Título\nconteúdo real");
});

test("stripHarmony: forma colapsada 'assistantfinal' (gateway removeu os <|...|>) — corta no marcador", () => {
  const leak = "analysisNow final output is markdown string. Proceed.assistantfinal[{\"path\":\"a.py\"}]";
  assert.equal(stripHarmony(leak), '[{"path":"a.py"}]');
});

test("stripHarmony: corta no canal final e remove tokens de controle residuais (<|end|> etc.)", () => {
  assert.equal(stripHarmony("<|channel|>final<|message|>olá<|end|>"), "olá");
});

test("stripHarmony: sem marcador de canal → texto preservado (só trim/tokens), sem destruir conteúdo", () => {
  assert.equal(stripHarmony("  conteúdo normal do usuário  "), "conteúdo normal do usuário");
  // NÃO corta em "assistant final" (com espaço) — é texto legítimo possível, não um marcador colapsado.
  assert.equal(stripHarmony("o assistant final review process"), "o assistant final review process");
});

test("stripHarmony: usa o ÚLTIMO marcador (o final real) quando há mais de um", () => {
  const leak = "<|channel|>analysis<|message|>penso...<|channel|>final<|message|>resposta";
  assert.equal(stripHarmony(leak), "resposta");
});

test("stripHarmony: vazio/entrada trivial", () => {
  assert.equal(stripHarmony(""), "");
  assert.equal(stripHarmony("   "), "");
});
