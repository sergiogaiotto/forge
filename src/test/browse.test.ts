import assert from "node:assert/strict";
import { test } from "node:test";
import { setHostLocale } from "../i18n";
import {
  BROWSE_MAX_ENTRIES,
  compileSearchPattern,
  isSearchablePath,
  renderFilesCard,
  renderSearchCard,
  renderTodoCard,
  SEARCH_MAX_LINE,
  SEARCH_MAX_MATCHES,
  SEARCH_MAX_PATTERN,
  searchInFiles,
  TODO_PATTERN,
} from "../workspace/browse";

const id = (s: string) => s; // máscara identidade para testes que não exercitam LGPD

test("compileSearchPattern: vazio orienta, longo recusa, inválido explica, válido compila case-insensitive", () => {
  assert.ok("error" in compileSearchPattern(""));
  assert.ok("error" in compileSearchPattern("   "));
  assert.ok("error" in compileSearchPattern("a".repeat(SEARCH_MAX_PATTERN + 1)));
  const bad = compileSearchPattern("([unclosed");
  assert.ok("error" in bad && bad.error.length > 0);
  const ok = compileSearchPattern("def\\s+process");
  assert.ok("re" in ok);
  assert.ok((ok as { re: RegExp }).re.test("DEF  Process")); // /i
});

test("searchInFiles: linha 1-based, agrupa por arquivo e para NO teto (truncated, varredura curta)", () => {
  const files = [
    { path: "a.py", content: "x = 1\ndef process(a):\n    return a" },
    { path: "b.py", content: "def process(b):\n    pass" },
  ];
  const r = searchInFiles(files, /def process/i);
  assert.equal(r.matches.length, 2);
  assert.deepEqual(r.matches[0], { path: "a.py", line: 2, text: "def process(a):" });
  assert.equal(r.filesWithMatches, 2);
  assert.equal(r.truncated, false);
  // teto: para cedo (early-stop), marcando truncated
  const many = Array.from({ length: 50 }, (_, i) => ({ path: `f${i}.txt`, content: "hit\nhit\nhit" }));
  const capped = searchInFiles(many, /hit/, 5);
  assert.equal(capped.matches.length, 5);
  assert.equal(capped.truncated, true);
  assert.ok(capped.scanned < 50, "a varredura deve PARAR no teto, não só capar a exibição");
});

test("searchInFiles: linha gigante é CAPADA antes do teste (anti-ReDoS/anti-inchaço)", () => {
  const long = "x".repeat(SEARCH_MAX_LINE + 100) + "AGULHA";
  const r = searchInFiles([{ path: "big.txt", content: long }], /AGULHA/);
  assert.equal(r.matches.length, 0); // a agulha está além do cap da linha — não é encontrada
  const early = searchInFiles([{ path: "big.txt", content: "AGULHA" + long }], /AGULHA/);
  assert.equal(early.matches.length, 1);
  assert.ok(early.matches[0].text.length <= SEARCH_MAX_LINE);
});

test("TODO_PATTERN: case-SENSITIVE — 'todos os arquivos' (pt) e 'todo el código' (es) NÃO são pendência", () => {
  assert.ok(TODO_PATTERN.test("# TODO: revisar isto"));
  assert.ok(TODO_PATTERN.test("// FIXME quebra no Windows"));
  assert.ok(TODO_PATTERN.test("<!-- HACK temporário -->"));
  assert.ok(TODO_PATTERN.test("XXX rever antes do release"));
  assert.ok(!TODO_PATTERN.test("aplica a todos os arquivos do workspace"));
  assert.ok(!TODO_PATTERN.test("recorre todo el código"));
  assert.ok(!TODO_PATTERN.test("método todoList() do serviço")); // \b não casa dentro de identificador
});

test("isSearchablePath: fonte entra; binário/artefato não", () => {
  assert.ok(isSearchablePath("src/app.py"));
  assert.ok(isSearchablePath("README.md"));
  assert.ok(isSearchablePath("consultas/relatorio.sql"));
  assert.ok(!isSearchablePath("docs/diagrama.png"));
  assert.ok(!isSearchablePath("data/vendas.parquet"));
  assert.ok(!isSearchablePath("package-lock.lock"));
  assert.ok(!isSearchablePath("dist/forge.vsix"));
});

test("renderFilesCard: filtro por prefixo (caixa/barra normalizadas), cap e mensagens de vazio", () => {
  const paths = ["src/a.py", "src/b.py", "docs/x.md"];
  const all = renderFilesCard(paths, undefined);
  assert.match(all, /Arquivos do workspace/);
  assert.ok(all.includes("`docs/x.md`"));
  assert.match(all, /Mostrando \*\*3\*\* de 3 arquivos/);
  const filtered = renderFilesCard(paths, "SRC/");
  assert.ok(filtered.includes("`src/a.py`"));
  assert.ok(!filtered.includes("docs/x.md"));
  assert.match(filtered, /`src\/`/); // o head mostra o filtro normalizado
  const none = renderFilesCard(paths, "nao-existe/");
  assert.match(none, /Nenhum arquivo casa com o filtro/);
  // cap: mais arquivos que o teto → linha "e mais N"
  const many = Array.from({ length: BROWSE_MAX_ENTRIES + 5 }, (_, i) => `f/${String(i).padStart(3, "0")}.py`);
  const capped = renderFilesCard(many, undefined);
  assert.match(capped, /e mais 5 arquivos/);
});

test("renderSearchCard/renderTodoCard: vazio orienta; achados agrupados por arquivo com máscara aplicada", () => {
  const empty = renderSearchCard("foo", { matches: [], filesWithMatches: 0, scanned: 12, truncated: false }, id);
  assert.match(empty, /Nenhuma ocorrência de `foo` em 12 arquivos/);
  const result = {
    matches: [
      { path: "a.py", line: 3, text: "email = 'joao@claro.com.br'" },
      { path: "a.py", line: 9, text: "print(email)" },
      { path: "b.py", line: 1, text: "email = None" },
    ],
    filesWithMatches: 2,
    scanned: 40,
    truncated: false,
  };
  const card = renderSearchCard("email", result, (s) => s.replace(/joao@claro\.com\.br/, "▇▇▇"));
  assert.match(card, /\*\*3 ocorrências\*\* em 2 arquivo\(s\) \(40 varridos\)/);
  assert.ok(card.includes("**`a.py`**"));
  assert.ok(card.includes("L3:"));
  assert.ok(card.includes("▇▇▇"), "a máscara LGPD deve valer nas linhas exibidas");
  assert.ok(!card.includes("joao@claro.com.br"));
  const todo = renderTodoCard({ ...result, matches: [{ path: "a.py", line: 1, text: "# TODO: x" }], filesWithMatches: 1 }, id);
  assert.match(todo, /TODOs do workspace/);
  assert.match(todo, /\*\*1 ocorrência\*\*/); // singular do ICU
});

test("cards do workspace em en/es: frame traduzido citando o label do locale (/files, /archivos)", () => {
  try {
    setHostLocale("en");
    const en = renderFilesCard(Array.from({ length: BROWSE_MAX_ENTRIES + 1 }, (_, i) => `f/${i}.py`), undefined);
    assert.match(en, /Workspace files/);
    assert.match(en, /use `\/files <folder>`/);
    setHostLocale("es");
    const es = renderFilesCard(Array.from({ length: BROWSE_MAX_ENTRIES + 1 }, (_, i) => `f/${i}.py`), undefined);
    assert.match(es, /Archivos del workspace/);
    assert.match(es, /usa `\/archivos <carpeta>`/);
    assert.match(renderTodoCard({ matches: [], filesWithMatches: 0, scanned: 3, truncated: false }, id), /Ningún TODO/);
  } finally {
    setHostLocale("pt-BR");
  }
});
