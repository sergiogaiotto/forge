import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildGitArgs,
  commitTargets,
  isWriteOp,
  parseLog,
  parseStatusPorcelain,
  renderDiffCard,
  renderGitError,
  renderLogCard,
  renderStatusCard,
  sanitizeCommitMessage,
  unquoteGitPath,
} from "../git/gitCommands";

test("isWriteOp: só commit é escrita (status/diff/log são leitura)", () => {
  assert.equal(isWriteOp("commit"), true);
  assert.equal(isWriteOp("status"), false);
  assert.equal(isWriteOp("diff"), false);
  assert.equal(isWriteOp("log"), false);
});

test("buildGitArgs: --no-pager sempre; a mensagem de commit é um ARG separado (nunca string de shell)", () => {
  assert.deepEqual(buildGitArgs("status"), ["--no-pager", "status", "--porcelain=v1", "--branch"]);
  assert.deepEqual(buildGitArgs("diff"), ["--no-pager", "diff", "--no-textconv", "HEAD"]);
  // a mensagem — mesmo com metacaracteres — vai como um único elemento do array (shell:false a torna literal)
  const args = buildGitArgs("commit", { message: "fix: $(rm -rf /) && echo pwned" });
  assert.deepEqual(args, ["commit", "-a", "-m", "fix: $(rm -rf /) && echo pwned"]);
  // log: cap entre 1 e 100
  assert.equal(buildGitArgs("log", { logCount: 999 }).includes("100"), true);
  assert.equal(buildGitArgs("log", { logCount: 0 }).includes("1"), true);
});

test("parseStatusPorcelain: branch, upstream, ahead/behind e entradas XY", () => {
  const out = "## main...origin/main [ahead 2, behind 1]\n M src/a.ts\nA  src/b.ts\n?? novo.ts\nD  velho.ts\n";
  const s = parseStatusPorcelain(out);
  assert.equal(s.branch, "main");
  assert.equal(s.upstream, "origin/main");
  assert.equal(s.ahead, 2);
  assert.equal(s.behind, 1);
  assert.equal(s.entries.length, 4);
  assert.deepEqual(s.entries[0], { index: " ", worktree: "M", path: "src/a.ts" });
  assert.deepEqual(s.entries[2], { index: "?", worktree: "?", path: "novo.ts" });
});

test("parseStatusPorcelain: branch sem upstream e 'No commits yet'", () => {
  assert.equal(parseStatusPorcelain("## feat/x\n").branch, "feat/x");
  assert.equal(parseStatusPorcelain("## No commits yet on main\n").branch, "main");
});

test("commitTargets: inclui staged e worktree-modified; EXCLUI untracked (novos exigem git add)", () => {
  const s = parseStatusPorcelain("## main\n M mod.ts\nA  staged.ts\n?? novo.ts\nMM ambos.ts\n D removido.ts\n");
  const t = commitTargets(s);
  assert.ok(t.includes("mod.ts"));
  assert.ok(t.includes("staged.ts"));
  assert.ok(t.includes("ambos.ts"));
  assert.ok(t.includes("removido.ts"));
  assert.ok(!t.includes("novo.ts"), "untracked NÃO entra num commit -a");
});

test("sanitizeCommitMessage: rejeita vazia e longa demais; aceita e faz trim", () => {
  assert.equal(sanitizeCommitMessage("").ok, false);
  assert.equal(sanitizeCommitMessage("   ").ok, false);
  assert.equal(sanitizeCommitMessage("x".repeat(2001)).ok, false);
  const ok = sanitizeCommitMessage("  feat: nova coisa  ");
  assert.equal(ok.ok, true);
  assert.equal(ok.message, "feat: nova coisa");
});

test("parseLog: campos separados por US, robusto a '|' e espaços no assunto", () => {
  const sep = "\x1f";
  const out = `a1b2c3${sep}Ana${sep}2 horas atrás${sep}feat: título com | barra\nd4e5f6${sep}Beto${sep}ontem${sep}fix: outro`;
  const commits = parseLog(out);
  assert.equal(commits.length, 2);
  assert.deepEqual(commits[0], { hash: "a1b2c3", author: "Ana", when: "2 horas atrás", subject: "feat: título com | barra" });
});

test("renderStatusCard: working tree limpo vs com arquivos (conta alvos do commit)", () => {
  assert.match(renderStatusCard(parseStatusPorcelain("## main\n")), /Working tree limpo/);
  const card = renderStatusCard(parseStatusPorcelain("## main\n M a.ts\n?? novo.ts\n"));
  assert.match(card, /`a\.ts`/);
  assert.match(card, /1 arquivo\(s\) rastreado\(s\) entrariam/); // novo.ts não conta
});

test("renderDiffCard: vazio vira aviso; conteúdo vira bloco diff (com cap)", () => {
  assert.match(renderDiffCard("   "), /Sem alterações/);
  assert.match(renderDiffCard("diff --git a/x b/x\n+linha"), /```diff/);
  assert.match(renderDiffCard("x".repeat(30000)), /diff truncado/);
});

test("renderLogCard: escapa '|' do assunto na tabela", () => {
  const card = renderLogCard([{ hash: "abc", author: "Ana", when: "hoje", subject: "a | b" }]);
  assert.match(card, /a \\\| b/);
});

test("unquoteGitPath: desfaz aspas + escapes; octal vira UTF-8; path cru passa igual", () => {
  assert.equal(unquoteGitPath("simples.ts"), "simples.ts"); // sem aspas = cru
  assert.equal(unquoteGitPath('"my file.ts"'), "my file.ts"); // espaço → aspas
  assert.equal(unquoteGitPath('"caf\\303\\251.ts"'), "café.ts"); // octal UTF-8 (quotepath=true)
  assert.equal(unquoteGitPath('"an\\303\\241lise.py"'), "análise.py");
  assert.equal(unquoteGitPath('"a\\"b.ts"'), 'a"b.ts'); // aspas escapada
  assert.equal(unquoteGitPath('"tab\\tfim.ts"'), "tab\tfim.ts"); // tab escapado
});

test("parseStatusPorcelain: nomes não-ASCII e com espaço são DESQUOTADOS na entrada", () => {
  const s = parseStatusPorcelain('## main\n M "caf\\303\\251.ts"\nA  "my file.ts"\n');
  assert.equal(s.entries[0].path, "café.ts");
  assert.equal(s.entries[1].path, "my file.ts");
  const card = renderStatusCard(s);
  assert.match(card, /`café\.ts`/);
  assert.match(card, /`my file\.ts`/);
});

test("parseStatusPorcelain: rename é separado em origPath → path (não uma string 'a -> b')", () => {
  const s = parseStatusPorcelain("## main\nR  velho.ts -> novo.ts\n");
  assert.equal(s.entries[0].path, "novo.ts");
  assert.equal(s.entries[0].origPath, "velho.ts");
  assert.equal(commitTargets(s).length, 1);
  assert.deepEqual(commitTargets(s), ["novo.ts"]);
  assert.match(renderStatusCard(s), /velho\.ts → novo\.ts/);
});

test("commitTargets: typechange (worktree 'T') É incluído — git commit -a o sela (furo de governança fechado)", () => {
  const s = parseStatusPorcelain("## main\n T link.ts\n M outro.ts\n");
  const t = commitTargets(s);
  assert.ok(t.includes("link.ts"), "typechange deve entrar na lista autorizada (git commit -a o sela)");
  assert.ok(t.includes("outro.ts"));
  assert.equal(t.length, 2); // dialogo autoriza 2, git sela 2 — sem N vs N+1
});

test("renderGitError: nomeia a operação CERTA (erro de status NÃO diz 'commit')", () => {
  assert.match(renderGitError("status", "not a git repository"), /### Git · status/);
  assert.match(renderGitError("diff", ""), /### Git · diff/);
  assert.match(renderGitError("log", "erro"), /### Git · log/);
  assert.doesNotMatch(renderGitError("status", "x"), /commit/);
});
