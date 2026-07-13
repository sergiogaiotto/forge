import assert from "node:assert/strict";
import { test } from "node:test";
import { AttachmentStore } from "../core/AttachmentStore";

function make() {
  let changes = 0;
  const store = new AttachmentStore(() => changes++);
  return { store, changes: () => changes };
}

test("add: ids sequenciais, chip com bytes do conteúdo, onChange por add", () => {
  const { store, changes } = make();
  store.add("a.py", "workspace", "print(1)");
  store.add("sel", "selection", "x = 2");
  assert.equal(changes(), 2);
  const chips = store.chips();
  assert.deepEqual(chips.map((c) => c.id), ["att_1", "att_2"]);
  assert.deepEqual(chips.map((c) => c.kind), ["workspace", "selection"]);
  assert.equal(chips[0].bytes, "print(1)".length);
  // o chip NÃO vaza o conteúdo (só metadados)
  assert.ok(!("content" in chips[0]));
  assert.equal(store.count(), 2);
});

test("add: conteúdo > 16000 é truncado com sufixo; bytes do chip refletem o capado", () => {
  const { store } = make();
  store.add("big", "upload", "x".repeat(20000));
  const [chip] = store.chips();
  assert.ok(chip.bytes <= 16000 + 20, "capado a ~16000");
  assert.match(store.contents()[0], /… \(truncado\)$/);
});

test("add: janela deslizante de 8 — o 9º empurra o mais antigo", () => {
  const { store } = make();
  for (let i = 1; i <= 10; i++) store.add(`f${i}`, "workspace", String(i));
  assert.equal(store.count(), 8, "mantém só 8");
  const labels = store.chips().map((c) => c.label);
  assert.deepEqual(labels, ["f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10"], "os 8 mais recentes");
});

test("remove: tira pelo id e notifica; id inexistente é no-op silencioso (sem onChange)", () => {
  const { store, changes } = make();
  store.add("a", "workspace", "1");
  store.add("b", "workspace", "2");
  const before = changes();
  store.remove("att_1");
  assert.equal(store.count(), 1);
  assert.equal(store.chips()[0].label, "b");
  assert.equal(changes(), before + 1, "removeu → notificou");
  store.remove("att_999"); // inexistente
  assert.equal(changes(), before + 1, "no-op → NÃO notificou");
});

test("clear: esvazia e notifica só se havia algo", () => {
  const { store, changes } = make();
  store.clear();
  assert.equal(changes(), 0, "clear vazio → sem post espúrio");
  store.add("a", "workspace", "1");
  const before = changes();
  store.clear();
  assert.equal(store.count(), 0);
  assert.equal(changes(), before + 1);
});

test("consumeAsContext: monta o bloco pt-BR e ESVAZIA; vazio → '' (sem notificar)", () => {
  const { store, changes } = make();
  assert.equal(store.consumeAsContext(), "", "vazio → string vazia");
  store.add("app.py", "workspace", "print(1)");
  store.add("erro", "search", "traceback");
  const c1 = changes();
  const block = store.consumeAsContext();
  assert.match(block, /^Anexos fornecidos pelo usuário:\n/);
  assert.match(block, /### Anexo: app\.py\n```\nprint\(1\)\n```/);
  assert.match(block, /### Anexo: erro\n```\ntraceback\n```/);
  assert.ok(block.endsWith("\n\n"));
  assert.equal(store.count(), 0, "consumido → esvaziado");
  assert.equal(changes(), c1, "consume NÃO chama onChange (o dono re-posta)");
});

test("contents: conteúdos crus (para a estimativa de tokens do /contexto)", () => {
  const { store } = make();
  store.add("a", "workspace", "hello");
  store.add("b", "upload", "world");
  assert.deepEqual(store.contents(), ["hello", "world"]);
});
