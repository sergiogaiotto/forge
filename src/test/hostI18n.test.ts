import assert from "node:assert/strict";
import { test } from "node:test";
import { getHostLocale, hostT, setHostLocale } from "../i18n";
import { HOST_MESSAGES, HostMessageKey } from "../i18n/hostMessages";
import { SUPPORTED_LOCALES } from "../shared/locale";

test("hostT: serve INGLÊS a um usuário en (o que o vscode.l10n nativo NÃO conseguiria com fonte pt-BR)", () => {
  setHostLocale("en");
  assert.equal(getHostLocale(), "en");
  assert.equal(hostT("dialog.skillsReindexed"), "FORGE: skills reindexed.");
  assert.equal(hostT("notice.noBlueprint"), "No approved blueprint. Plan the project first.");
  setHostLocale("pt-BR");
  assert.equal(hostT("dialog.skillsReindexed"), "FORGE: skills reindexadas.");
  assert.equal(hostT("notice.charterSaved"), "Charter salvo em .forge/project.md (injetado em todo prompt).");
});

test("hostT: chave inexistente cai na própria chave (buraco visível, nunca vazio)", () => {
  setHostLocale("en");
  assert.equal(hostT("nao.existe" as HostMessageKey), "nao.existe");
  setHostLocale("pt-BR");
});

test("catálogo host: EN cobre TODAS as chaves do pt-BR e nenhuma string vazia", () => {
  const ptKeys = Object.keys(HOST_MESSAGES["pt-BR"]).sort();
  const enKeys = Object.keys(HOST_MESSAGES.en).sort();
  assert.deepEqual(enKeys, ptKeys, "pt-BR e en devem ter exatamente as mesmas chaves");
  assert.ok(ptKeys.length >= 6, `esperado >=6 chaves no piloto, achei ${ptKeys.length}`);
  for (const loc of SUPPORTED_LOCALES) {
    for (const [k, v] of Object.entries(HOST_MESSAGES[loc])) assert.ok(v && v.length > 0, `${loc}.${k} vazio`);
  }
});

test("guard: nenhum vscode.l10n.t remanescente (o mecanismo nativo não serve pt-BR-first)", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const url = await import("node:url");
  const repo = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..", "..");
  for (const rel of ["src/extension.ts", "src/core/Controller.ts"]) {
    const src = fs.readFileSync(path.join(repo, rel), "utf8");
    assert.ok(!/vscode\.l10n\.t\(/.test(src), `${rel} ainda usa vscode.l10n.t — use hostT (pt-BR-first)`);
  }
  // e o campo "l10n" do package.json foi removido (o vsce empacotaria bundles mortos)
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
  assert.equal(pkg.l10n, undefined, 'package.json não deve ter o campo "l10n" (mecanismo nativo abandonado)');
});
