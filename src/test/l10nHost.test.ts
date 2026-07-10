import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Guard do i18n do HOST (vscode.l10n). Sem a API vscode nos testes, validamos a CONSISTÊNCIA dos
// bundles com o código: toda string passada a `vscode.l10n.t("…")` no host deve existir como chave nos
// bundles l10n/, e os bundles pt-BR (source) e en devem ter o MESMO conjunto de chaves — senão um
// usuário en vê a string na língua-fonte (pt-BR) sem aviso, ou o vsce empacota um bundle incompleto.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function readJson(rel: string): Record<string, string> {
  return JSON.parse(fs.readFileSync(path.join(REPO, rel), "utf8"));
}

// Extrai as strings literais de `l10n.t("…")` (simples, sem template/interpolação) de um arquivo.
function extractL10nKeys(relFile: string): string[] {
  const src = fs.readFileSync(path.join(REPO, relFile), "utf8");
  const keys: string[] = [];
  for (const m of src.matchAll(/l10n\.t\(\s*"((?:[^"\\]|\\.)*)"/g)) {
    // desfaz os escapes comuns de string TS para casar com a chave literal do bundle JSON
    keys.push(m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
  }
  return keys;
}

const SOURCE = readJson("l10n/bundle.l10n.json");
const EN = readJson("l10n/bundle.l10n.en.json");
// Arquivos do host que já usam vscode.l10n.t no piloto desta fatia.
const HOST_FILES = ["src/extension.ts", "src/core/Controller.ts"];

test("l10n host: todo vscode.l10n.t(\"…\") do código tem chave no bundle source E no en", () => {
  const used = new Set<string>();
  for (const f of HOST_FILES) for (const k of extractL10nKeys(f)) used.add(k);
  assert.ok(used.size >= 6, `esperado >=6 strings l10n.t no piloto, achei ${used.size}`);
  for (const k of used) {
    assert.ok(k in SOURCE, `l10n.t("${k}") sem chave em l10n/bundle.l10n.json`);
    assert.ok(k in EN, `l10n.t("${k}") sem tradução em l10n/bundle.l10n.en.json`);
  }
});

test("l10n host: bundles source e en têm o MESMO conjunto de chaves (sem tradução faltando/órfã)", () => {
  assert.deepEqual(Object.keys(EN).sort(), Object.keys(SOURCE).sort(), "l10n/bundle.l10n.json e .en.json devem ter as mesmas chaves");
});

test("l10n host: source é identidade (chave == valor) e en NÃO deixou string em pt-BR por engano", () => {
  for (const [k, v] of Object.entries(SOURCE)) assert.equal(v, k, `bundle source deve ser identidade: "${k}"`);
  // toda tradução en deve DIFERIR do pt-BR (senão a string não foi traduzida). As chaves do piloto não
  // têm forma idêntica entre os idiomas (não há nome próprio isolado), então divergência é esperada.
  for (const [k, v] of Object.entries(EN)) {
    assert.ok(v.length > 0, `tradução en vazia para "${k}"`);
    assert.notEqual(v, k, `tradução en idêntica ao pt-BR (não traduzida?): "${k}"`);
  }
});

test("l10n host: nenhuma chave do bundle está ÓRFÃ (definida mas nunca usada no código)", () => {
  const used = new Set<string>();
  for (const f of HOST_FILES) for (const k of extractL10nKeys(f)) used.add(k);
  for (const k of Object.keys(SOURCE)) assert.ok(used.has(k), `chave "${k}" no bundle mas não usada em nenhum vscode.l10n.t do host`);
});
