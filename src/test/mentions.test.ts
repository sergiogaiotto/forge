import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkspaceEntry } from "../shared/protocol";
import { atMentionToken, dedupeMentions, filterMentions, mentionInsertText, replaceMention, splitMentionLabel } from "../../webview-ui/src/mentions";

test("atMentionToken: dispara no @ que inicia token (início ou após espaço), com o caret dentro", () => {
  assert.deepEqual(atMentionToken("@", 1), { query: "", start: 0 });
  assert.deepEqual(atMentionToken("@src", 4), { query: "src", start: 0 });
  assert.deepEqual(atMentionToken("olha o @src/ad", 14), { query: "src/ad", start: 7 });
  // query com caracteres de caminho é ok
  assert.deepEqual(atMentionToken("@src/adapters/db.ts", 19), { query: "src/adapters/db.ts", start: 0 });
});

test("atMentionToken: NÃO dispara em e-mail (@ no meio de palavra) nem com espaço no token", () => {
  assert.equal(atMentionToken("fale com a@b.com", 16), null); // @ precedido por 'a' → e-mail
  assert.equal(atMentionToken("@src foo", 8), null); // espaço no token (caret depois do espaço) → fechou
  assert.equal(atMentionToken("sem arroba", 10), null);
});

test("atMentionToken: usa o caret — token ANTES do caret, não o @ mais à frente", () => {
  const text = "@a rest @b";
  // caret logo após "@a" (posição 2) → token "a", não "b"
  assert.deepEqual(atMentionToken(text, 2), { query: "a", start: 0 });
  // caret no fim → token "b"
  assert.deepEqual(atMentionToken(text, text.length), { query: "b", start: 8 });
});

test("replaceMention: limpa o @token e reposiciona o caret", () => {
  const text = "olha o @src/ad e mais";
  const tok = atMentionToken(text, 14)!; // { query: "src/ad", start: 7 }
  const r = replaceMention(text, tok, "");
  assert.equal(r.text, "olha o  e mais"); // o "@src/ad" saiu (o chip carrega o conteúdo)
  assert.equal(r.caret, 7);
  // com uma referência inline (se um dia quisermos)
  const r2 = replaceMention(text, tok, "@src/adapters/db.ts ");
  assert.equal(r2.text, "olha o @src/adapters/db.ts  e mais");
});

// REGRESSÃO (revisão adversarial, HIGH): o caret pode estar no MEIO do token (via ← ou clique). replaceMention
// deve consumir o token INTEIRO (até o próximo espaço/fim), não só até o caret — senão sobra lixo no composer.
test("replaceMention: consome o token inteiro mesmo com o caret no MEIO", () => {
  // "@README.md" com o caret em 8 (@README.|md) → query "README." mas o token inteiro é "@README.md"
  const tokMid = atMentionToken("@README.md", 8)!; // { query: "README.", start: 0 }
  assert.deepEqual(replaceMention("@README.md", tokMid, ""), { text: "", caret: 0 });
  // no meio de uma mensagem
  const tok2 = atMentionToken("see @src/db.ts here", 10)!; // { query: "src/d", start: 4 }
  assert.deepEqual(replaceMention("see @src/db.ts here", tok2, ""), { text: "see  here", caret: 4 });
});

const files: WorkspaceEntry[] = [
  { path: "src/adapters/db.ts", kind: "file" },
  { path: "src/domain/order.ts", kind: "file" },
  { path: "src/adapters", kind: "folder" },
  { path: "README.md", kind: "file" },
  { path: "docs/db-notes.md", kind: "file" },
];

test("filterMentions: ranqueia basename exato > começa > contém > caminho contém", () => {
  const r = filterMentions(files, "db", 12).map((e) => e.path);
  // "db.ts" (basename começa com db) e "db-notes.md" (basename começa com db) vêm antes de paths que só contêm "db"
  assert.ok(r[0] === "src/adapters/db.ts" || r[0] === "docs/db-notes.md");
  assert.ok(r.includes("src/adapters/db.ts") && r.includes("docs/db-notes.md"));
  // "src/adapters" (contém "d"? não "db") não deve aparecer para query "db"? contém "d" mas não "db" → fora
  assert.ok(!r.includes("src/adapters")); // não contém "db"
});

test("filterMentions: query vazia → primeiros N (ordem estável do host); limit respeitado", () => {
  assert.deepEqual(filterMentions(files, "", 2).length, 2);
  assert.deepEqual(filterMentions(files, "  ", 12).length, files.length);
});

test("filterMentions: fuzzy por subsequência quando não há match direto", () => {
  // "adb": não é substring de nenhum path, mas é subsequência de "src/adapters/db.ts" (a→d→b)
  const r = filterMentions(files, "adb", 12).map((e) => e.path);
  assert.ok(r.includes("src/adapters/db.ts"));
  // sem nenhum match → vazio
  assert.deepEqual(filterMentions(files, "zzzzz", 12), []);
});

test("filterMentions: ranking por SEGMENTO — `adapters/db` casa src/adapters/db.ts (caminho digitado)", () => {
  const r = filterMentions(files, "adapters/db", 12).map((e) => e.path);
  assert.ok(r.includes("src/adapters/db.ts"), "segmentos casam em ordem, sem substring literal contíguo");
  // um caminho parcial não-contíguo que NÃO casa os segmentos em ordem não entra por este tier
  assert.ok(!filterMentions(files, "domain/db", 12).map((e) => e.path).includes("src/adapters/db.ts"));
});

test("mentionInsertText: arquivo vira `@caminho ` e pasta `@caminho/ ` (espaço final fecha o token)", () => {
  assert.equal(mentionInsertText({ path: "src/core/Controller.ts", kind: "file" }), "@src/core/Controller.ts ");
  assert.equal(mentionInsertText({ path: "webview-ui/src", kind: "folder" }), "@webview-ui/src/ ");
  // a inserção, reparseada no fim, NÃO reabre o picker (o espaço final fecha o token)
  const inserted = mentionInsertText({ path: "a/b.ts", kind: "file" });
  assert.equal(atMentionToken(inserted, inserted.length), null);
});

test("splitMentionLabel: separa diretório (esmaecido) do basename (forte)", () => {
  assert.deepEqual(splitMentionLabel("src/core/Controller.ts"), { dir: "src/core/", base: "Controller.ts" });
  assert.deepEqual(splitMentionLabel("README.md"), { dir: "", base: "README.md" });
  assert.deepEqual(splitMentionLabel("webview-ui/src"), { dir: "webview-ui/", base: "src" });
});

test("dedupeMentions: funde cache + search-on-type sem duplicar caminho (mantém a 1ª, preserva ordem)", () => {
  const cache: WorkspaceEntry[] = [
    { path: "src/a.ts", kind: "file" },
    { path: "src", kind: "folder" },
  ];
  const search: WorkspaceEntry[] = [
    { path: "src/a.ts", kind: "file" }, // duplicado do cache
    { path: "deep/nested/b.ts", kind: "file" }, // fora do teto → só no search
  ];
  const merged = dedupeMentions([...cache, ...search]).map((e) => e.path);
  assert.deepEqual(merged, ["src/a.ts", "src", "deep/nested/b.ts"], "sem duplicado, ordem preservada, item novo do search entra");
  assert.deepEqual(dedupeMentions([]), []);
});
