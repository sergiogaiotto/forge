import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateTokens, estimateTokensOf } from "../util/tokenEstimate";

test("estimateTokens: vazio = 0 e cresce com o tamanho", () => {
  assert.equal(estimateTokens(""), 0);
  const a = estimateTokens("def foo(): return 1");
  const b = estimateTokens("def foo(): return 1\n".repeat(10));
  assert.ok(a > 0);
  assert.ok(b > a);
});

test("estimateTokens: código denso em símbolos não subestima (>= chars/4)", () => {
  const code = "x={'a':[1,2,3],'b':(4,5)};y=f(x)+g(x)*2";
  assert.ok(estimateTokens(code) >= Math.ceil(code.length / 4));
});

test("estimateTokensOf: soma com overhead por item", () => {
  const total = estimateTokensOf(["abcd", "abcd"], 4);
  assert.ok(total >= 8, `esperava >=8, veio ${total}`);
});
