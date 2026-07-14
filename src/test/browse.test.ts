import assert from "node:assert/strict";
import { test } from "node:test";
import { setHostLocale } from "../i18n";
import {
  BROWSE_MAX_ENTRIES,
  buildMentionCatalog,
  compileSearchPattern,
  hasNestedQuantifier,
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
import { isSensitiveFile } from "../util/errorRefs";

const id = (s: string) => s; // máscara identidade para testes que não exercitam LGPD

test("buildMentionCatalog: deriva pastas ancestrais e ordena (pastas primeiro, alfabético)", () => {
  const items = buildMentionCatalog(["src/core/Controller.ts", "src/util/x.ts", "README.md"], () => false);
  assert.deepEqual(
    items,
    [
      { path: "src", kind: "folder" },
      { path: "src/core", kind: "folder" },
      { path: "src/util", kind: "folder" },
      { path: "README.md", kind: "file" },
      { path: "src/core/Controller.ts", kind: "file" },
      { path: "src/util/x.ts", kind: "file" },
    ],
    "cada segmento ancestral vira pasta citável; pastas antes dos arquivos"
  );
});

test("buildMentionCatalog: EXCLUI segredos do catálogo (denylist REAL isSensitiveFile) — não viram citáveis", () => {
  const items = buildMentionCatalog(
    ["src/app.ts", ".env", "config/.env.production", "keys/server.pem", "creds/aws_credentials.json", "src/private_key.py"],
    isSensitiveFile
  );
  const paths = items.map((i) => i.path);
  assert.ok(!paths.includes(".env"), ".env fora");
  assert.ok(!paths.includes("config/.env.production"), ".env.* fora");
  assert.ok(!paths.includes("keys/server.pem"), "*.pem fora");
  assert.ok(!paths.includes("creds/aws_credentials.json"), "credentials fora");
  assert.ok(paths.includes("src/app.ts"), "fonte comum entra");
  assert.ok(paths.includes("src/private_key.py"), "private_key.PY é FONTE legítima — entra (SENSITIVE_UNLESS_SOURCE)");
});

test("buildMentionCatalog: pasta que só continha segredo NÃO aparece; a que tem fonte, sim", () => {
  const items = buildMentionCatalog(["keys/server.pem", "app/main.ts"], isSensitiveFile);
  const folders = items.filter((i) => i.kind === "folder").map((i) => i.path);
  assert.ok(!folders.includes("keys"), "a pasta 'keys' some (só tinha o .pem excluído)");
  assert.ok(folders.includes("app"), "'app' fica (tem main.ts)");
});

test("buildMentionCatalog: entrada vazia/falsy é robusta", () => {
  assert.deepEqual(buildMentionCatalog([], () => false), []);
  assert.deepEqual(buildMentionCatalog(["", "a.ts"], () => false), [{ path: "a.ts", kind: "file" }]);
});

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

// BLOCKER da revisão adversarial: o cap de linha NÃO barra backtracking EXPONENCIAL. O detector de
// quantificador aninhado (star-height ≥ 2) é a defesa primária — recusa antes de compilar/rodar.
test("hasNestedQuantifier: pega a assinatura catastrófica; libera padrões legítimos", () => {
  // catastróficos (recusados)
  for (const p of ["(a+)+$", "(a*)*", "(a+)*b", "(\\w+\\s?)*", "(-+)+>", "((a+))+", "(ab+)+", "(x+){2,}"]) {
    assert.ok(hasNestedQuantifier(p), `deveria detectar aninhamento: ${p}`);
  }
  // legítimos (liberados)
  for (const p of ["def\\s+process", "a*b*c*", "(a|b)+", "TODO|FIXME", "\\bclass\\s+\\w+", "foo.*bar", "[a-z]+_id", "(err){1,3}", "a+"]) {
    assert.ok(!hasNestedQuantifier(p), `NÃO deveria detectar: ${p}`);
  }
  // classe de caractere e escape não confundem o detector: `[()+]+` é um quantificador simples sobre a
  // classe; `\(a+\)+` são parênteses LITERAIS (escapados), sem grupo.
  assert.ok(!hasNestedQuantifier("[()+]+"));
  assert.ok(!hasNestedQuantifier("\\(a+\\)+"));
});

test("compileSearchPattern: recusa quantificador aninhado com mensagem de segurança", () => {
  const r = compileSearchPattern("(a+)+$");
  assert.ok("error" in r);
  assert.match((r as { error: string }).error, /aninhado|catastr/i);
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
  assert.equal(r.timedOut, false);
  // teto: para cedo (early-stop), marcando truncated
  const many = Array.from({ length: 50 }, (_, i) => ({ path: `f${i}.txt`, content: "hit\nhit\nhit" }));
  const capped = searchInFiles(many, /hit/, { maxMatches: 5 });
  assert.equal(capped.matches.length, 5);
  assert.equal(capped.truncated, true);
  assert.ok(capped.scanned < 50, "a varredura deve PARAR no teto, não só capar a exibição");
});

test("searchInFiles: orçamento de wall-clock corta a varredura (defesa anti-ReDoS residual, now injetável)", () => {
  const files = Array.from({ length: 100 }, (_, i) => ({ path: `f${i}.txt`, content: "nada\nnada" }));
  let clock = 0;
  const now = () => (clock += 10); // cada chamada avança 10ms → estoura um budget de 30ms cedo
  const r = searchInFiles(files, /zzz/, { budgetMs: 30, now });
  assert.equal(r.timedOut, true);
  assert.ok(r.scanned < 100, "deve parar assim que o orçamento estoura");
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
  const empty = renderSearchCard("foo", { matches: [], filesWithMatches: 0, scanned: 12, truncated: false, timedOut: false }, id);
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
    timedOut: false,
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
  // timedOut → aviso de resultado parcial (defesa anti-ReDoS residual)
  assert.match(renderSearchCard("x", { ...result, timedOut: true }, id), /interrompida ao passar de 1500ms/);
});

// Injeção de markdown: backtick é caractere de nome de arquivo LEGAL — um repo hostil manda um path com
// `` ` `` para quebrar o code span. codeSafe troca ` por ' em TUDO que vem do disco (path, linha, prefixo).
test("renderFilesCard/renderSearchCard: backtick em path/linha/prefixo é neutralizado (repo hostil)", () => {
  const evil = "x`](http://evil).md";
  const files = renderFilesCard([evil], undefined);
  assert.ok(!files.includes("`x`]"), "o backtick do path NÃO pode fechar o code span");
  assert.ok(files.includes("x'](http://evil).md"), "backtick vira ' dentro do span");
  const search = renderSearchCard("p`p", { matches: [{ path: evil, line: 1, text: "a `b` c" }], filesWithMatches: 1, scanned: 1, truncated: false, timedOut: false }, id);
  assert.ok(!search.includes("`b`"), "o backtick da linha também é neutralizado");
  assert.ok(search.includes("Busca · `p'p`"), "o backtick do padrão ecoado também");
  const filtered = renderFilesCard(["a.py"], "p`x");
  assert.ok(filtered.includes("`p'x`"));
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
    assert.match(renderTodoCard({ matches: [], filesWithMatches: 0, scanned: 3, truncated: false, timedOut: false }, id), /Ningún TODO/);
  } finally {
    setHostLocale("pt-BR");
  }
});
