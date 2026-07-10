import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_LOCALE, resolveLocale, SUPPORTED_LOCALES } from "../shared/locale";
import { formatMessage } from "../shared/format";
import { MESSAGES, MessageKey } from "../../webview-ui/src/i18n/messages";
import { setLocaleForTest, t } from "../../webview-ui/src/i18n";

test("resolveLocale: casa por prefixo; desconhecido → pt-BR (pt-BR-first)", () => {
  assert.equal(resolveLocale("pt-br"), "pt-BR");
  assert.equal(resolveLocale("pt-BR"), "pt-BR");
  assert.equal(resolveLocale("en"), "en");
  assert.equal(resolveLocale("en-US"), "en");
  assert.equal(resolveLocale("es"), "es"); // PR 11: es suportado
  assert.equal(resolveLocale("es-419"), "es");
  assert.equal(resolveLocale("fr"), "pt-BR"); // não suportado → default
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

test("catálogo: TODO locale cobre TODAS as chaves do pt-BR (nenhum fallback silencioso)", () => {
  const ptKeys = Object.keys(MESSAGES["pt-BR"]).sort();
  for (const loc of SUPPORTED_LOCALES) {
    if (loc === "pt-BR") continue;
    assert.deepEqual(Object.keys(MESSAGES[loc]).sort(), ptKeys, `pt-BR e ${loc} devem ter exatamente as mesmas chaves`);
  }
  // e nenhuma string vazia
  for (const loc of SUPPORTED_LOCALES) {
    for (const [k, v] of Object.entries(MESSAGES[loc])) assert.ok(v && v.length > 0, `${loc}.${k} vazio`);
  }
});

test("t: es traduz (PR 11 — a arquitetura escala adicionando um catálogo)", () => {
  setLocaleForTest("es");
  assert.equal(t("app.loading"), "Cargando FORGE…");
  assert.equal(t("common.allow"), "Permitir");
  assert.equal(t("ctx.history", { count: 1 }), "Historial (1 turno)");
  assert.equal(t("ctx.history", { count: 3 }), "Historial (3 turnos)");
  setLocaleForTest("pt-BR");
});

// GUARD DE MANIFESTO (o design pediu como check de CI). Layout NATIVO do VSCode: a BASE package.nls.json
// é INGLÊS (o VSCode curto-circuita o idioma-default 'en' e usa a base — um package.nls.en.json seria
// código morto); package.nls.pt-br.json é o OVERRIDE pt-BR. Todo %chave% do package.json deve existir
// nos DOIS, senão o VSCode renderiza o placeholder cru (%cmd.x%) ou o pt-BR degrada para inglês.
test("package.nls: todo %chave% do package.json existe na base (en) E nos overrides pt-br/es; base é inglês", () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const pkg = fs.readFileSync(path.join(repo, "package.json"), "utf8");
  const nlsEn = JSON.parse(fs.readFileSync(path.join(repo, "package.nls.json"), "utf8")) as Record<string, string>;
  const nlsPt = JSON.parse(fs.readFileSync(path.join(repo, "package.nls.pt-br.json"), "utf8")) as Record<string, string>;
  const nlsEs = JSON.parse(fs.readFileSync(path.join(repo, "package.nls.es.json"), "utf8")) as Record<string, string>;
  // package.nls.en.json NÃO deve existir (o VSCode nunca o carregaria para um usuário en — dead code)
  assert.ok(!fs.existsSync(path.join(repo, "package.nls.en.json")), "package.nls.en.json é código morto (en é a base); remova-o");
  // Chave nls começa em minúscula (namespace com ou sem ponto). O anchor [a-z] exclui env vars all-caps
  // em exemplos (%LOCALAPPDATA%) mas pega chaves SEM ponto.
  const used = [...new Set([...pkg.matchAll(/%([a-z][\w.]*)%/g)].map((m) => m[1]))];
  assert.ok(used.length >= 19, `esperado >=19 chaves nls em uso, achei ${used.length}`);
  for (const k of used) {
    assert.ok(k in nlsEn, `chave %${k}% usada no package.json mas ausente na base package.nls.json (en)`);
    assert.ok(k in nlsPt, `chave %${k}% usada no package.json mas ausente no override package.nls.pt-br.json`);
    assert.ok(k in nlsEs, `chave %${k}% usada no package.json mas ausente no override package.nls.es.json`);
  }
  // sem chaves órfãs (definidas mas não usadas)
  for (const k of Object.keys(nlsEn)) assert.ok(used.includes(k), `chave "${k}" em package.nls.json não é usada no package.json`);
  // base (en) e overrides (pt-br, es) com o MESMO conjunto de chaves
  assert.deepEqual(Object.keys(nlsPt).sort(), Object.keys(nlsEn).sort(), "package.nls.json (en) e package.nls.pt-br.json devem ter as mesmas chaves");
  assert.deepEqual(Object.keys(nlsEs).sort(), Object.keys(nlsEn).sort(), "package.nls.json (en) e package.nls.es.json devem ter as mesmas chaves");
});
