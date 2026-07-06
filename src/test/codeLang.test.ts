import assert from "node:assert/strict";
import { test } from "node:test";
import { fileExtForLang } from "../util/codeLang";

test("fileExtForLang: linguagens de arquivo mapeiam para uma extensão (case/space-insensitive)", () => {
  assert.equal(fileExtForLang("python"), "py");
  assert.equal(fileExtForLang("py"), "py");
  assert.equal(fileExtForLang("TypeScript"), "ts"); // case-insensitive
  assert.equal(fileExtForLang(" go "), "go"); // trim
  assert.equal(fileExtForLang("yaml"), "yaml");
  assert.equal(fileExtForLang("yml"), "yaml"); // apelido → mesma extensão
  assert.equal(fileExtForLang("golang"), "go");
});

test("fileExtForLang: shell/saída/texto/vazio NÃO são salváveis (null → sem botão)", () => {
  for (const l of ["bash", "sh", "shell", "console", "text", "plaintext", "diff", "log", "output", "", "  "]) {
    assert.equal(fileExtForLang(l), null, `"${l}" não deveria ser salvável`);
  }
});
