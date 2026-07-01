import assert from "node:assert/strict";
import { test } from "node:test";
import {
  closedBlockPaths,
  parseFileBlocks,
  parsePartialFileBlocks,
  stripFileBlockOfPath,
  stripFileBlocksFromText,
} from "../util/fileBlocks";
import { parseCellBlocks } from "../util/cellBlocks";

test("closedBlockPaths retorna só blocos FECHADOS com path (progresso um-a-um do Modo Projeto)", () => {
  const closedA = ["```forge-file path=a.py", "x = 1", "```"].join("\n");
  const openB = ["```forge-file path=b.py", "def f():"].join("\n"); // sem cerca de fechamento → aberto
  assert.deepEqual(closedBlockPaths(closedA + "\n" + openB), ["a.py"]); // b.py aberto não conta
  const closedC = ["```forge-file path=c.py", "y = 2", "```"].join("\n");
  assert.deepEqual(closedBlockPaths(closedA + "\n" + closedC), ["a.py", "c.py"]); // dois fechados, em ordem
  assert.deepEqual(closedBlockPaths("só prosa, sem cercas"), []);
});

test("extracts a single file block", () => {
  const text = [
    "Aqui está a função limpar:",
    "```forge-file path=churn_pipeline.py",
    "def limpar(df):",
    "    return df.drop_duplicates()",
    "```",
    "Pronto.",
  ].join("\n");
  const blocks = parseFileBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].path, "churn_pipeline.py");
  assert.match(blocks[0].content, /def limpar/);
  assert.ok(!blocks[0].content.endsWith("\n"));
});

test("extracts multiple blocks and strips quotes around the path", () => {
  const text = [
    '```forge-file path="a/b.py"',
    "x = 1",
    "```",
    "texto",
    "```forge-file path=c.sql",
    "select 1;",
    "```",
  ].join("\n");
  const blocks = parseFileBlocks(text);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].path, "a/b.py");
  assert.equal(blocks[1].path, "c.sql");
  assert.equal(blocks[1].content, "select 1;");
});

test("returns nothing when there is no file block", () => {
  assert.equal(parseFileBlocks("apenas uma explicação, sem código").length, 0);
});

// ---- parsePartialFileBlocks (streaming ao vivo) -----------------------------

test("partial parser marks a closed block as closed", () => {
  const text = ["```forge-file path=a.py", "x = 1", "```"].join("\n");
  const blocks = parsePartialFileBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].path, "a.py");
  assert.equal(blocks[0].content, "x = 1");
  assert.equal(blocks[0].closed, true);
});

test("partial parser captures an open (still streaming) block", () => {
  const text = ["antes", "```forge-file path=a.py", "linha 1", "linha 2 incompl"].join("\n");
  const blocks = parsePartialFileBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].path, "a.py");
  assert.equal(blocks[0].closed, false);
  assert.match(blocks[0].content, /linha 1\nlinha 2 incompl/);
});

test("partial parser handles a header line that is still arriving", () => {
  const text = "texto\n```forge-file path=sentiment_age";
  const blocks = parsePartialFileBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].path, "sentiment_age");
  assert.equal(blocks[0].closed, false);
  assert.equal(blocks[0].content, "");
});

test("partial parser mixes a closed block followed by an open one", () => {
  const text = [
    "```forge-file path=a.py",
    "a = 1",
    "```",
    "entre",
    "```forge-file path=b.py",
    "b = 2",
  ].join("\n");
  const blocks = parsePartialFileBlocks(text);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].closed, true);
  assert.equal(blocks[1].path, "b.py");
  assert.equal(blocks[1].closed, false);
});

// ---- stripFileBlocksFromText (prosa exibida) --------------------------------

test("strip removes a closed block but keeps the surrounding prose", () => {
  const text = ["Olha o arquivo:", "```forge-file path=a.py", "x = 1", "```", "Pronto."].join("\n");
  const out = stripFileBlocksFromText(text);
  assert.match(out, /Olha o arquivo:/);
  assert.match(out, /Pronto\./);
  assert.ok(!out.includes("forge-file"));
  assert.ok(!out.includes("x = 1"));
});

test("strip removes an open block that is still streaming", () => {
  const text = ["Gerando…", "```forge-file path=a.py", "linha incompl"].join("\n");
  const out = stripFileBlocksFromText(text);
  assert.equal(out, "Gerando…");
});

test("strip is a no-op for prose without file blocks", () => {
  assert.equal(stripFileBlocksFromText("só texto"), "só texto");
});

// ---- consistência webview ↔ host (achados da revisão adversarial) ------------

test("closed block without a path is ignored by every parser (no silent loss)", () => {
  // O host (parseFileBlocks) exige path não-vazio; a webview deve concordar — senão o conteúdo
  // some da prosa e vira um cartão morto permanente.
  const text = ["Olha:", "```forge-file path=", "print('ola')", "```", "fim"].join("\n");
  assert.equal(parseFileBlocks(text).length, 0);
  assert.equal(parsePartialFileBlocks(text).filter((b) => b.closed).length, 0);
  const out = stripFileBlocksFromText(text);
  assert.match(out, /print\('ola'\)/); // conteúdo preservado na prosa
});

test("closed block with no path= at all is ignored by every parser", () => {
  const text = ["Olha:", "```forge-file", "print('ola')", "```", "fim"].join("\n");
  assert.equal(parseFileBlocks(text).length, 0);
  assert.equal(parsePartialFileBlocks(text).filter((b) => b.closed).length, 0);
  assert.match(stripFileBlocksFromText(text), /print\('ola'\)/);
});

test("fence that is a prefix of a larger token does not match (```forge-fileXYZ)", () => {
  const text = ["antes", "```forge-fileXYZ path=a.py", "x = 1", "```", "depois"].join("\n");
  assert.equal(parseFileBlocks(text).length, 0);
  assert.equal(parsePartialFileBlocks(text).length, 0);
  // Nada é removido — o texto cru permanece (consistente com o host não gerar proposta).
  const out = stripFileBlocksFromText(text);
  assert.match(out, /x = 1/);
  assert.match(out, /forge-fileXYZ/);
});

test("a valid block right after a false-prefix fence is still found", () => {
  const text = [
    "```forge-fileXYZ ignora isto",
    "```forge-file path=ok.py",
    "y = 2",
    "```",
  ].join("\n");
  const blocks = parsePartialFileBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].path, "ok.py");
  assert.equal(blocks[0].closed, true);
});

// ---- cerca de 4 crases: conteúdo com cercas internas (o bug do parser) ------

test("4-backtick fence preserves the whole content even with an inner ```bash block", () => {
  // Um README cujo CONTEÚDO tem suas próprias cercas de 3 crases: com a cerca externa de 4 crases,
  // o parser NÃO pode truncar no fence interno. Este é exatamente o bug corrigido.
  const text = [
    "Aqui o README:",
    "````forge-file path=README.md",
    "# Projeto",
    "",
    "Instale com:",
    "```bash",
    "pip install foo",
    "```",
    "",
    "Fim do README.",
    "````",
    "Pronto.",
  ].join("\n");
  const blocks = parseFileBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].path, "README.md");
  assert.match(blocks[0].content, /```bash/);
  assert.match(blocks[0].content, /pip install foo/);
  assert.match(blocks[0].content, /Fim do README\./);
  assert.ok(!blocks[0].content.includes("forge-file"));
  // a cerca externa de 4 crases não deve sobrar no conteúdo
  assert.ok(!blocks[0].content.includes("````"));
});

test("a 3-backtick line does NOT close a 4-backtick block (closing count must match)", () => {
  const text = [
    "````forge-file path=a.md",
    "conteúdo antes",
    "```",
    "conteúdo depois",
    "````",
  ].join("\n");
  const blocks = parseFileBlocks(text);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].content, /conteúdo antes/);
  assert.match(blocks[0].content, /conteúdo depois/);
  // a cerca de 3 crases ficou preservada DENTRO do conteúdo (não foi tratada como fechamento)
  assert.ok(blocks[0].content.includes("```"));
});

test("backward compat: a 3-backtick block (no inner fences) still closes at 3 backticks", () => {
  const text = ["```forge-file path=a.py", "x = 1", "y = 2", "```", "depois"].join("\n");
  const blocks = parseFileBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].path, "a.py");
  assert.equal(blocks[0].content, "x = 1\ny = 2");
});

test("a closing fence with trailing whitespace still closes the block", () => {
  const text = ["````forge-file path=a.md", "oi", "````   "].join("\n");
  const blocks = parseFileBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].content, "oi");
});

test("partial parser keeps an inner fence while a 4-backtick block is still streaming", () => {
  const text = [
    "````forge-file path=a.md",
    "# t",
    "```bash",
    "ls",
    "```",
    "ainda gerando",
  ].join("\n");
  const blocks = parsePartialFileBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].closed, false);
  assert.match(blocks[0].content, /```bash/);
  assert.match(blocks[0].content, /ainda gerando/);
});

test("strip removes an entire 4-backtick block with an inner fence (no truncation)", () => {
  const text = [
    "Olha:",
    "````forge-file path=a.md",
    "# t",
    "```bash",
    "ls",
    "```",
    "````",
    "Fim.",
  ].join("\n");
  const out = stripFileBlocksFromText(text);
  assert.match(out, /Olha:/);
  assert.match(out, /Fim\./);
  assert.ok(!out.includes("forge-file"));
  assert.ok(!out.includes("ls")); // bloco inteiro removido, não truncado no fence interno
  assert.ok(!out.includes("```bash"));
});

// ---- stripFileBlockOfPath (webview remove a cerca quando a proposta chega) ----

// ---- tolerância a cercas malformadas (recoverOpenBlock) ----------------------
// Sem isso, o bloco vira texto cru no chat, sem cartão "Aplicar" (bug observado com gpt-oss-120b ao
// gerar um requirements.txt). A recuperação só roda no parser FINAL e é CONSERVADORA: ver os achados
// da revisão adversarial cobertos pelos testes "regressão"/"guarda" abaixo.

test("C (caso real): abre com 3 crases e fecha com 4 — recuperado, conteúdo limpo", () => {
  const text = ["```forge-file path=requirements.txt", "pygame>=2.0", "transformers>=4.40", "````"].join("\n");
  const blocks = parseFileBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].path, "requirements.txt");
  assert.equal(blocks[0].content, "pygame>=2.0\ntransformers>=4.40");
  assert.ok(!blocks[0].content.includes("`")); // a cerca solta de 4 foi consumida como fechamento
});

test("E: bloco aberto nunca fechado (truncado) é recuperado até o fim do texto", () => {
  const text = ["Segue o arquivo:", "```forge-file path=requirements.txt", "pygame>=2.0", "transformers>=4.40"].join("\n");
  const blocks = parseFileBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].content, "pygame>=2.0\ntransformers>=4.40");
});

test("D: abre com 4 e fecha com 3 — recuperado; a cerca curta NÃO é tratada como fechamento", () => {
  // Limitação documentada e aceitável: a cerca de 3 (< 4) fica no conteúdo (visível no diff). NÃO a
  // aparamos porque seria indistinguível do fechamento legítimo de um bloco interno (achados #8/#12).
  const text = ["````forge-file path=requirements.txt", "pygame>=2.0", "transformers>=4.40", "```"].join("\n");
  const blocks = parseFileBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].content, "pygame>=2.0\ntransformers>=4.40\n```");
});

// -- regressão crítica (achados #1–#4): cerca interna MAIS LONGA que a externa não pode fechar cedo --

test("regressão #1: cerca interna de 4 NÃO fecha um bloco bem-formado aberto com 3 (sem perda)", () => {
  const text = ["```forge-file path=guide.md", "linha A", "````", "linha B", "```"].join("\n");
  const blocks = parseFileBlocks(text);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].content, /linha A/);
  assert.match(blocks[0].content, /linha B/); // conteúdo COMPLETO preservado
  assert.ok(blocks[0].content.includes("````")); // a cerca interna de 4 permanece no conteúdo
});

test("regressão #1 (protocolo): bloco de 4 preserva cerca interna de 5", () => {
  const text = ["````forge-file path=doc.md", "# Guia", "`````", "exemplo", "`````", "Fim.", "````"].join("\n");
  const blocks = parseFileBlocks(text);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].content, /# Guia/);
  assert.match(blocks[0].content, /Fim\./);
  assert.ok(blocks[0].content.includes("`````"));
});

test("regressão #2: strip de um bloco bem-formado com cerca interna longa não vaza a cauda", () => {
  const text = ["Olha:", "```forge-file path=g.md", "antes", "````", "depois", "```", "Fim."].join("\n");
  const out = stripFileBlocksFromText(text);
  assert.match(out, /Olha:/);
  assert.match(out, /Fim\./);
  assert.ok(!out.includes("antes")); // bloco inteiro removido, sem truncar na cerca interna
  assert.ok(!out.includes("depois"));
});

// -- amálgama: um bloco nunca atravessa a abertura do próximo (achados #1, #4, #5/#10) ------------

test("amálgama #5/#10: bloco aberto seguido de OUTRO forge-file — os DOIS viram proposta, sem mistura", () => {
  const text = [
    "```forge-file path=a.txt",
    "corpo A",
    "````forge-file path=b.md",
    "corpo B",
    "````",
  ].join("\n");
  const blocks = parseFileBlocks(text);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].path, "a.txt");
  assert.equal(blocks[0].content, "corpo A"); // NÃO engole b.md
  assert.ok(!blocks[0].content.includes("corpo B"));
  assert.equal(blocks[1].path, "b.md");
  assert.equal(blocks[1].content, "corpo B");
});

test("amálgama #1 (3/3, caso provável): 1º bloco aberto fechado pela cerca do 2º — sem engolir", () => {
  // gpt-oss-120b só usa 3 crases e esquece o fechamento do 1º arquivo. A cerca ``` do 2º bloco
  // fecharia o 1º (mesma contagem); o parser final delimita o 1º na abertura do 2º.
  const text = [
    "Primeiro:",
    "```forge-file path=app.py",
    "import sys",
    "Segundo:",
    "```forge-file path=utils.py",
    "def f(): pass",
    "```",
  ].join("\n");
  const blocks = parseFileBlocks(text);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].path, "app.py");
  assert.ok(!blocks[0].content.includes("utils.py")); // não engole o cabeçalho do 2º bloco
  assert.ok(!blocks[0].content.includes("def f")); // nem o corpo do 2º
  assert.equal(blocks[1].path, "utils.py");
  assert.equal(blocks[1].content, "def f(): pass");
});

test("amálgama cross-type #4: forge-file aberto NÃO engole um forge-cell seguinte", () => {
  const text = [
    "```forge-file path=requirements.txt",
    "pygame>=2.0",
    "````forge-cell path=churn.ipynb op=replace index=2",
    "df = df.drop_duplicates()",
    "````",
  ].join("\n");
  const fileBlocks = parseFileBlocks(text);
  assert.equal(fileBlocks.length, 1);
  assert.equal(fileBlocks[0].path, "requirements.txt");
  assert.equal(fileBlocks[0].content, "pygame>=2.0"); // o forge-cell NÃO entra no requirements.txt
  assert.ok(!fileBlocks[0].content.includes("drop_duplicates"));
  // o forge-cell segue sendo reconhecido pelo seu próprio parser (sem duplicação)
  const cells = parseCellBlocks(text);
  assert.equal(cells.length, 1);
  assert.equal(cells[0].path, "churn.ipynb");
});

// -- bloco bem-formado que DOCUMENTA o protocolo no corpo não pode ser truncado (3ª revisão) ------

test("doc K1: bloco de 4 com um ```forge-file interno (3) no corpo NÃO é truncado nem dividido", () => {
  const text = [
    "````forge-file path=README.md",
    "# Doc",
    "Emita assim:",
    "```forge-file path=exemplo.py",
    "print('oi')",
    "```",
    "Pronto.",
    "````",
  ].join("\n");
  const blocks = parseFileBlocks(text);
  assert.equal(blocks.length, 1); // um só bloco — a cerca interna de 3 é CONTEÚDO, não 2º bloco
  assert.equal(blocks[0].path, "README.md");
  assert.match(blocks[0].content, /print\('oi'\)/);
  assert.match(blocks[0].content, /Pronto\./); // corpo COMPLETO, sem truncar na cerca interna
  assert.ok(blocks[0].content.includes("```forge-file path=exemplo.py"));
});

test("doc K2: bloco de 4 com um ```forge-cell interno (3) no corpo não é truncado", () => {
  const text = [
    "````forge-file path=README.md",
    "# Projeto",
    "```forge-cell path=nb.ipynb op=add",
    "x = 1",
    "```",
    "Fim do README.",
    "````",
  ].join("\n");
  const blocks = parseFileBlocks(text);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].content, /Fim do README\./);
  assert.ok(blocks[0].content.includes("```forge-cell"));
});

test("doc L: menção ao protocolo no MEIO de uma linha (string) não abre bloco nem trunca", () => {
  const text = [
    "```forge-file path=a.py",
    "comment = 'use ```forge-file path=x.py here'",
    "code = 2",
    "```",
  ].join("\n");
  const blocks = parseFileBlocks(text);
  assert.equal(blocks.length, 1); // a menção mid-line não vira 2º bloco
  assert.equal(blocks[0].path, "a.py");
  assert.match(blocks[0].content, /code = 2/);
  assert.ok(blocks[0].content.includes("use ```forge-file path=x.py here"));
});

test("col-0 (#asimetria): cerca forge-file INDENTADA não é reconhecida (não engole a cauda)", () => {
  // Abertura e fechamento exigem coluna 0 (simétrico). Um bloco indentado (ex.: num item de lista) não
  // vira proposta — fica como prosa — em vez de abrir-sem-fechar e engolir sua própria cerca + a cauda.
  const text = ["1. Primeiro:", "   ```forge-file path=a.py", "   x=1", "   ```", "Depois."].join("\n");
  assert.equal(parseFileBlocks(text).length, 0);
});

test("col-0: cerca na coluna 0 segue sendo reconhecida normalmente", () => {
  const text = ["```forge-file path=a.py", "x=1", "```"].join("\n");
  assert.equal(parseFileBlocks(text).length, 1);
  assert.equal(parseFileBlocks(text)[0].content, "x=1");
});

test("doc: strip de um bloco que documenta o protocolo não vaza cerca crua na prosa", () => {
  const text = [
    "Veja:",
    "````forge-file path=README.md",
    "Emita:",
    "```forge-file path=ex.py",
    "y = 2",
    "```",
    "Fim.",
    "````",
    "Pronto.",
  ].join("\n");
  const out = stripFileBlockOfPath(text, "README.md");
  assert.match(out, /Veja:/);
  assert.match(out, /Pronto\./);
  assert.ok(!out.includes("forge-file")); // nada de cerca crua sobrando
  assert.ok(!out.includes("y = 2"));
});

// -- guardas da recuperação (achados #6–#13) ----------------------------------

test("guarda #6/#13: bloco cujo único conteúdo é uma cerca NÃO vira proposta de arquivo vazio", () => {
  // ````forge-file ... \n``` : a cerca de 3 não fecha o bloco de 4 e é o único "conteúdo".
  const text = ["````forge-file path=a.txt", "```"].join("\n");
  assert.equal(parseFileBlocks(text).length, 0); // senão sobrescreveria a.txt com vazio
});

test("guarda: recuperação exige path e corpo real", () => {
  assert.equal(parseFileBlocks(["```forge-file", "sem caminho"].join("\n")).length, 0);
  assert.equal(parseFileBlocks("texto\n```forge-file path=req.txt").length, 0); // header sem corpo
});

test("guarda #8: bloco de 4 truncado com ```python interno preserva o fechamento interno", () => {
  // Modelo abre com 4, escreve um README com ```python ... ``` e trunca SEM a cerca externa. A cauda
  // ``` é o fechamento LEGÍTIMO do bloco interno — a recuperação não pode apará-la.
  const text = ["````forge-file path=README.md", "# R", "```python", "x = 1", "```"].join("\n");
  const blocks = parseFileBlocks(text);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].content, /```python/);
  assert.match(blocks[0].content, /x = 1/);
  assert.ok(blocks[0].content.trimEnd().endsWith("```")); // fechamento interno preservado
});

// -- CRLF (achado #14) --------------------------------------------------------

test("CRLF: caso C com \\r\\n é recuperado com conteúdo limpo", () => {
  const text = ["```forge-file path=requirements.txt", "pygame>=2.0", "transformers>=4.40", "````"].join("\r\n");
  const blocks = parseFileBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].content, "pygame>=2.0\r\ntransformers>=4.40");
});

test("CRLF: cerca interna de 4 (\\r\\n) não fecha um bloco bem-formado aberto com 3", () => {
  const text = ["```forge-file path=g.md", "linha A", "````", "linha B", "```"].join("\r\n");
  const blocks = parseFileBlocks(text);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].content, /linha A/);
  assert.match(blocks[0].content, /linha B/);
});

// -- consistência strip <-> recovery ------------------------------------------

test("strip é consistente com a recuperação: bloco recuperado some da prosa (sem duplicar)", () => {
  const text = ["Segue:", "```forge-file path=req.txt", "pygame>=2.0", "transformers>=4.40", "````"].join("\n");
  assert.equal(parseFileBlocks(text).length, 1);
  const out = stripFileBlockOfPath(text, "req.txt");
  assert.match(out, /Segue:/);
  assert.ok(!out.includes("forge-file"));
  assert.ok(!out.includes("pygame"));
});

test("strip do bloco C recuperado mantém a prosa que vem DEPOIS da cerca solta", () => {
  const text = ["```forge-file path=req.txt", "pygame>=2.0", "````", "mais prosa aqui"].join("\n");
  const blocks = parseFileBlocks(text);
  assert.equal(blocks[0].content, "pygame>=2.0"); // corta na cerca solta, não engole a prosa
  const out = stripFileBlockOfPath(text, "req.txt");
  assert.match(out, /mais prosa aqui/);
  assert.ok(!out.includes("pygame"));
});

test("backward compat: fechamentos de mesmo tamanho (3/3 e 4/4) seguem limpos", () => {
  const three = ["```forge-file path=a.py", "x = 1", "```"].join("\n");
  const four = ["````forge-file path=b.md", "# t", "````"].join("\n");
  assert.equal(parseFileBlocks(three)[0].content, "x = 1");
  assert.equal(parseFileBlocks(four)[0].content, "# t");
});

test("extractPath (#3): atributos extras após o path não entram no caminho", () => {
  const text = ["```forge-file path=a.py mode=overwrite", "x = 1", "```"].join("\n");
  assert.equal(parseFileBlocks(text)[0].path, "a.py"); // não "a.py mode=overwrite"
});

test("extractPath: aspas permitem espaço no caminho", () => {
  const text = ['```forge-file path="src/meu arquivo.py"', "x = 1", "```"].join("\n");
  assert.equal(parseFileBlocks(text)[0].path, "src/meu arquivo.py");
});

test("removeBlocks (#5): colapsa linhas em branco também em CRLF", () => {
  const text = ["Olha:", "```forge-file path=a.py", "x=1", "```", "", "", "", "Fim."].join("\r\n");
  const out = stripFileBlocksFromText(text);
  assert.ok(!/(\r?\n){3,}/.test(out)); // no máximo uma linha em branco entre prosas
  assert.match(out, /Olha:/);
  assert.match(out, /Fim\./);
});

test("stripFileBlockOfPath removes only the block of the given path, fence-aware", () => {
  const text = [
    "Dois arquivos:",
    "````forge-file path=a.md",
    "# A",
    "```bash",
    "echo a",
    "```",
    "````",
    "entre",
    "```forge-file path=b.py",
    "b = 1",
    "```",
  ].join("\n");
  const out = stripFileBlockOfPath(text, "a.md");
  assert.ok(!out.includes("# A"));
  assert.ok(!out.includes("echo a")); // bloco de 4 crases removido por inteiro
  assert.match(out, /b = 1/); // o outro bloco permanece
  assert.match(out, /Dois arquivos:/);
  assert.match(out, /entre/);
});
