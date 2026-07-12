import assert from "node:assert/strict";
import { test } from "node:test";
import { scanA11y } from "../util/a11yLint";

const rules = (files: { path: string; content: string }[]): string[] => scanA11y(files).map((f) => f.rule);
const one = (path: string, content: string) => scanA11y([{ path, content }]);

// --- img sem alt ---
test("a11y img-alt: <img> sem alt acusa; com alt (inclusive alt='') não", () => {
  assert.deepEqual(rules([{ path: "a.tsx", content: '<img src="x.png" />' }]), ["img-alt"]);
  assert.deepEqual(rules([{ path: "a.tsx", content: '<img src="x.png" alt="Logo" />' }]), []);
  assert.deepEqual(rules([{ path: "a.tsx", content: '<img src="x.png" alt="" />' }]), [], "alt vazio = decorativa, VÁLIDO");
  assert.deepEqual(rules([{ path: "a.tsx", content: "<img src={x} {...rest} />" }]), [], "spread → pode ter alt → não acusa");
});

// --- html sem lang ---
test("a11y html-lang: <html> sem lang acusa; com lang não", () => {
  assert.deepEqual(rules([{ path: "i.html", content: "<html>\n<head></head>\n</html>" }]), ["html-lang"]);
  assert.deepEqual(rules([{ path: "i.html", content: '<html lang="pt-BR"><head></head></html>' }]), []);
});

// --- botão-ícone sem nome ---
test("a11y button-name: botão só com ícone acusa; com texto, {expr}, aria-label ou title não", () => {
  assert.deepEqual(rules([{ path: "b.tsx", content: "<button><svg viewBox='0 0'/></button>" }]), ["button-name"]);
  assert.deepEqual(rules([{ path: "b.tsx", content: "<button><i class='icon-trash'></i></button>" }]), ["button-name"]);
  assert.deepEqual(rules([{ path: "b.tsx", content: "<button>Salvar</button>" }]), [], "texto visível");
  assert.deepEqual(rules([{ path: "b.tsx", content: "<button>{t('save')}</button>" }]), [], "expressão JSX pode ser o nome");
  assert.deepEqual(rules([{ path: "b.tsx", content: "<button aria-label='Excluir'><svg/></button>" }]), [], "aria-label");
  assert.deepEqual(rules([{ path: "b.tsx", content: "<button title='Excluir'><svg/></button>" }]), [], "title");
  assert.deepEqual(rules([{ path: "b.tsx", content: "<button {...props}><svg/></button>" }]), [], "spread → não acusa");
});

// --- input sem rótulo (placeholder não é rótulo — F-15/F-16) ---
test("a11y input-label: input com placeholder e sem rótulo acusa; rotulado não", () => {
  assert.deepEqual(rules([{ path: "f.tsx", content: '<input type="text" placeholder="Seu nome" />' }]), ["input-label"]);
  assert.deepEqual(rules([{ path: "f.tsx", content: '<input placeholder="Email" aria-label="Email" />' }]), [], "aria-label");
  assert.deepEqual(rules([{ path: "f.tsx", content: '<label for="nm">Nome</label><input id="nm" placeholder="Seu nome" />' }]), [], "<label for> casando o id");
  assert.deepEqual(rules([{ path: "f.tsx", content: '<label>Nome <input placeholder="Seu nome" /></label>' }]), [], "label envolvente logo antes");
  assert.deepEqual(rules([{ path: "f.tsx", content: '<input type="hidden" placeholder="x" />' }]), [], "hidden não precisa de rótulo");
  assert.deepEqual(rules([{ path: "f.tsx", content: '<input type="text" aria-label="Busca" />' }]), [], "sem placeholder → conservador, não acusa");
  assert.deepEqual(rules([{ path: "f.tsx", content: '<input {...register("email")} placeholder="Email" />' }]), [], "spread → pode ter rótulo");
});

// --- só varre frontend ---
test("a11y: só varre html/jsx/tsx/vue/svelte — .py/.ts/.md são ignorados", () => {
  assert.deepEqual(rules([{ path: "app.py", content: '<img src="x">' }]), [], ".py não é frontend");
  assert.deepEqual(rules([{ path: "util.ts", content: "<button><svg/></button>" }]), [], ".ts não é frontend (lógica, não markup)");
  assert.deepEqual(rules([{ path: "README.md", content: "<img src='x'>" }]), []);
  assert.equal(one("Page.vue", '<template><img src="x" /></template>').length, 1, ".vue é frontend");
});

// --- linha e cap ---
test("a11y: reporta a LINHA e respeita o teto de achados", () => {
  const found = one("p.html", '<html>\n<body>\n<img src="a">\n</body>\n</html>');
  assert.ok(found.some((f) => f.rule === "html-lang" && f.line === 1));
  assert.ok(found.some((f) => f.rule === "img-alt" && f.line === 3));
  const many = "<img src='x'>\n".repeat(120);
  assert.ok(scanA11y([{ path: "big.html", content: many }]).length <= 50, "cap de 50");
});
