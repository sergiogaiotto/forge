import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_LOCALE, resolveLocale, SUPPORTED_LOCALES } from "../shared/locale";
import { formatMessage } from "../../webview-ui/src/i18n/format";
import { MESSAGES, MessageKey } from "../../webview-ui/src/i18n/messages";
import { setLocaleForTest, t } from "../../webview-ui/src/i18n";

test("resolveLocale: casa por prefixo; desconhecido → pt-BR (pt-BR-first)", () => {
  assert.equal(resolveLocale("pt-br"), "pt-BR");
  assert.equal(resolveLocale("pt-BR"), "pt-BR");
  assert.equal(resolveLocale("en"), "en");
  assert.equal(resolveLocale("en-US"), "en");
  assert.equal(resolveLocale("es"), "pt-BR"); // não suportado ainda → default
  assert.equal(resolveLocale(""), "pt-BR");
  assert.equal(resolveLocale(undefined), "pt-BR");
  assert.equal(DEFAULT_LOCALE, "pt-BR");
});

test("formatMessage: interpolação nomeada; var ausente fica literal", () => {
  assert.equal(formatMessage("olá {name}", { name: "Ana" }), "olá Ana");
  assert.equal(formatMessage("escopo {scope}.", { scope: "readonly" }), "escopo readonly.");
  assert.equal(formatMessage("faltou {x}"), "faltou {x}"); // ausente → literal (buraco visível)
});

test("formatMessage: mini-ICU plural one/other com # substituído", () => {
  const tpl = "{count, plural, one{# arquivo} other{# arquivos}}";
  assert.equal(formatMessage(tpl, { count: 1 }), "1 arquivo");
  assert.equal(formatMessage(tpl, { count: 3 }), "3 arquivos");
  assert.equal(formatMessage(tpl, { count: 0 }), "0 arquivos"); // 0 → other (regra pt-BR/en)
  // plural + texto ao redor + interpolação fora do bloco
  assert.equal(
    formatMessage("{name}: {count, plural, one{# item} other{# itens}}", { name: "lista", count: 2 }),
    "lista: 2 itens"
  );
});

test("formatMessage: aceita a forma CANÔNICA do ICU com espaços (one {…}) além da compacta (one{…})", () => {
  // forma idiomática que ferramentas de tradução emitem — não pode vazar o template cru
  assert.equal(formatMessage("{count, plural, one {# item} other {# itens}}", { count: 1 }), "1 item");
  assert.equal(formatMessage("{ count , plural , one {# item} other {# itens} }", { count: 5 }), "5 itens");
  // a forma compacta segue funcionando (retrocompat)
  assert.equal(formatMessage("{count, plural, one{# item} other{# itens}}", { count: 1 }), "1 item");
});

test("t: usa o locale ativo; en traduz; fallback pt-BR quando a chave falta no en", () => {
  setLocaleForTest("en");
  assert.equal(t("app.loading"), "Loading FORGE…");
  assert.equal(t("common.allow"), "Allow");
  assert.equal(t("mcp.approve.scope", { scope: "read" }), "(scope read).");
  setLocaleForTest("pt-BR");
  assert.equal(t("app.loading"), "Carregando FORGE…");
  assert.equal(t("common.deny"), "Negar");
});

test("t: chave inexistente cai na própria chave (buraco visível, nunca vazio)", () => {
  setLocaleForTest("pt-BR");
  assert.equal(t("nao.existe" as MessageKey), "nao.existe");
});

test("catálogo: EN cobre TODAS as chaves do pt-BR (nenhum fallback silencioso no piloto)", () => {
  const ptKeys = Object.keys(MESSAGES["pt-BR"]).sort();
  const enKeys = Object.keys(MESSAGES.en).sort();
  assert.deepEqual(enKeys, ptKeys, "pt-BR e en devem ter exatamente as mesmas chaves no piloto");
  // e nenhuma string vazia
  for (const loc of SUPPORTED_LOCALES) {
    for (const [k, v] of Object.entries(MESSAGES[loc])) assert.ok(v && v.length > 0, `${loc}.${k} vazio`);
  }
});

// GUARD DE MANIFESTO (o design pediu como check de CI): todo %chave% do package.json deve existir nos
// DOIS bundles nls — senão o VSCode renderiza o placeholder cru (%cmd.x%) ao usuário, ou o EN degrada
// para pt-BR sem aviso.
test("package.nls: todo %chave% do package.json existe em package.nls.json E package.nls.en.json", () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const pkg = fs.readFileSync(path.join(repo, "package.json"), "utf8");
  const nlsPt = JSON.parse(fs.readFileSync(path.join(repo, "package.nls.json"), "utf8")) as Record<string, string>;
  const nlsEn = JSON.parse(fs.readFileSync(path.join(repo, "package.nls.en.json"), "utf8")) as Record<string, string>;
  // Chave nls começa em minúscula (namespace com ou sem ponto: "cmd.focus" ou "signOut"). O anchor [a-z]
  // exclui env vars em exemplos (%LOCALAPPDATA%, all-caps) que também usam a sintaxe %…% — mas pega
  // chaves SEM ponto (o guard não pode depender só da convenção cmd.*).
  const used = [...new Set([...pkg.matchAll(/%([a-z][\w.]*)%/g)].map((m) => m[1]))];
  assert.ok(used.length >= 19, `esperado >=19 chaves nls em uso, achei ${used.length}`);
  for (const k of used) {
    assert.ok(k in nlsPt, `chave %${k}% usada no package.json mas ausente em package.nls.json`);
    assert.ok(k in nlsEn, `chave %${k}% usada no package.json mas ausente em package.nls.en.json`);
  }
  // sem chaves órfãs (definidas mas não usadas) — mantém os bundles enxutos
  for (const k of Object.keys(nlsPt)) assert.ok(used.includes(k), `chave "${k}" em package.nls.json não é usada no package.json`);
  // pt-BR e en com o MESMO conjunto de chaves
  assert.deepEqual(Object.keys(nlsEn).sort(), Object.keys(nlsPt).sort(), "package.nls.json e .en.json devem ter as mesmas chaves");
});
