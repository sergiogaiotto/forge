import assert from "node:assert/strict";
import { test } from "node:test";
import { ProjectGateRunner } from "../core/ProjectGateRunner";
import type { GateRunnerDeps } from "../core/ProjectGateRunner";
import type { ManagedConfig } from "../config/ManagedConfig";
import type { RunService } from "../core/RunService";
import type { Task } from "../core/Task";

// A ORQUESTRAÇÃO do gate (dispatch por linguagem, arquitetura que bloqueia, DoD, cômputo dos flags de
// contrato, side-effects de post/obs, fronteira de estado por RETORNO) era o que não tinha teste — este
// arquivo a fixa como asserção de CI. Roda o ramo JAVA: ele exercita materialização + arquitetura + DoD +
// contract flags + post SEM spawnar toolchain (checks vazio), então é 100% determinístico em qualquer CI.

type FakeEntry = { proposal: { filePath: string; modified: string; cell?: boolean; partial?: boolean }; results: unknown[]; gateOk: boolean };

function makeTask(files: { path: string; content: string; cell?: boolean; partial?: boolean }[]): { task: Task; entries: Map<string, FakeEntry> } {
  const entries = new Map<string, FakeEntry>();
  for (const f of files) {
    entries.set(f.path, { proposal: { filePath: f.path, modified: f.content, cell: f.cell, partial: f.partial }, results: [], gateOk: true });
  }
  const task = {
    taskId: "task-test",
    proposals: entries,
    settleValidations: async () => undefined,
  } as unknown as Task;
  return { task, entries };
}

function makeDeps(
  task: Task | undefined,
  over: Partial<{ definitionOfDone: boolean; blockUnverifiedContract: boolean; securityGate: string; deadImportsGate: boolean; reconcileDependencies: boolean; testEnabled: boolean }> = {}
): { deps: GateRunnerDeps; posts: any[]; obsRecs: any[] } {
  const posts: any[] = [];
  const obsRecs: any[] = [];
  const config = {
    securityGate: () => over.securityGate ?? "off",
    deadImportsGate: () => over.deadImportsGate ?? false,
    definitionOfDone: () => over.definitionOfDone ?? false,
    blockUnverifiedContract: () => over.blockUnverifiedContract ?? false,
    reconcileDependencies: () => over.reconcileDependencies ?? true,
    env: () => ({ timeoutSeconds: 900 }),
    test: () => ({ enabled: over.testEnabled ?? false }),
    run: () => ({ timeoutSeconds: 120 }),
  } as unknown as ManagedConfig;
  const runService = { isBusy: () => false, runCommand: async () => undefined } as unknown as RunService;
  const deps: GateRunnerDeps = {
    currentTask: () => task,
    projectSession: () => null,
    workspaceRoot: () => undefined,
    config,
    runService,
    post: (m) => posts.push(m),
    obs: { record: (e) => obsRecs.push(e) },
    log: { info: () => undefined, warn: () => undefined },
  };
  return { deps, posts, obsRecs };
}

test("run: sem task → {summary:null, state:null} e ZERO side-effect", async () => {
  const { deps, posts, obsRecs } = makeDeps(undefined);
  const res = await new ProjectGateRunner(deps).run("java", "hexagonal", true);
  assert.deepEqual(res, { summary: null, state: null });
  assert.equal(posts.length, 0);
  assert.equal(obsRecs.length, 0);
});

test("run: linguagem não suportada → {null,null} (early-return, sem post)", async () => {
  const { task } = makeTask([{ path: "q.sql", content: "select 1" }]);
  const { deps, posts } = makeDeps(task);
  const res = await new ProjectGateRunner(deps).run("sql" as any, "hexagonal", true);
  assert.equal(res.summary, null);
  assert.equal(res.state, null);
  assert.equal(posts.length, 0);
});

test("run: projeto java SEM arquivo compilável (só README) → {null,null}", async () => {
  const { task } = makeTask([{ path: "README.md", content: "# doc" }]);
  const { deps, posts } = makeDeps(task);
  const res = await new ProjectGateRunner(deps).run("java", "hexagonal", true);
  assert.equal(res.summary, null);
  assert.equal(res.state, null);
  assert.equal(posts.length, 0);
});

test("run: violação de ARQUITETURA (domínio importa adapters) BLOQUEIA o arquivo violador", async () => {
  const { task, entries } = makeTask([
    { path: "src/domain/Order.java", content: "package com.acme.domain;\nimport com.acme.adapters.Db;\npublic class Order {}" },
    { path: "src/adapters/Db.java", content: "package com.acme.adapters;\npublic class Db {}" },
  ]);
  const { deps, posts, obsRecs } = makeDeps(task, { definitionOfDone: false }); // isola a arquitetura do DoD
  const res = await new ProjectGateRunner(deps).run("java", "hexagonal", true);

  assert.ok(res.summary, "java devolve um summary");
  assert.equal(res.summary!.architectureErrors.length, 1, "uma violação de camada");
  assert.match(res.summary!.architectureErrors[0].path, /domain\/Order\.java$/);
  // O arquivo violador é bloqueado; o adapter (outer, sem erro) passa.
  assert.equal(entries.get("src/domain/Order.java")!.gateOk, false, "domínio violador → gateOk=false");
  assert.equal(entries.get("src/adapters/Db.java")!.gateOk, true, "adapter → gateOk=true");
  // Side-effects: exatamente 1 post project/gate (com a violação nos files) + 1 obs phase.timing.
  const gatePosts = posts.filter((p) => p.type === "project/gate");
  assert.equal(gatePosts.length, 1);
  assert.ok(gatePosts[0].files.some((f: any) => /domain\/Order\.java$/.test(f.path)));
  assert.equal(obsRecs.filter((e) => e.type === "phase.timing" && e.phase === "gate").length, 1);
  // Fronteira de estado: devolvida por RETORNO (não escrita no runner), com lastGateRun ecoando os inputs.
  assert.ok(res.state, "state devolvido");
  assert.deepEqual(res.state!.lastGateRun, { language: "java", architecture: "hexagonal", complete: true });
});

test("run: projeto java COERENTE (sem violação, DoD off) → nada bloqueia, gateOk=true, state devolvido", async () => {
  const { task, entries } = makeTask([
    { path: "src/domain/Order.java", content: "package com.acme.domain;\npublic class Order {}" },
    { path: "src/adapters/Db.java", content: "package com.acme.adapters;\nimport com.acme.domain.Order;\npublic class Db {}" },
  ]);
  const { deps, posts } = makeDeps(task, { definitionOfDone: false });
  const res = await new ProjectGateRunner(deps).run("java", "hexagonal", false);

  assert.ok(res.summary);
  assert.equal(res.summary!.architectureErrors.length, 0, "adapter→domain é a direção PERMITIDA");
  assert.equal(entries.get("src/domain/Order.java")!.gateOk, true);
  assert.equal(entries.get("src/adapters/Db.java")!.gateOk, true);
  const gatePost = posts.find((p) => p.type === "project/gate");
  assert.ok(gatePost);
  // O post e o state concordam sobre a semântica de contrato (mesma fonte computada).
  assert.equal(gatePost.requiresContractConfirm, res.state!.contractUnverified);
  assert.equal(res.state!.contractUnverified, false, "sem bloqueio + DoD off + java advisory → sem confirmação");
});

test("run: a11y adverte sobre o frontend gerado (advisory, NÃO bloqueia) — independe da linguagem", async () => {
  const { task, entries } = makeTask([
    { path: "Main.java", content: "package com.acme.app;\npublic class Main {}" },
    { path: "templates/index.html", content: '<html>\n<body>\n<img src="logo.png">\n</body>\n</html>' },
  ]);
  const { deps } = makeDeps(task, { definitionOfDone: false });
  const res = await new ProjectGateRunner(deps).run("java", "hexagonal", true);
  assert.ok(res.summary);
  assert.ok((res.summary!.a11yAdvisories ?? []).length >= 2, "html sem lang + img sem alt → advisories");
  assert.ok(res.summary!.a11yAdvisories!.some((a) => /index\.html/.test(a)));
  // Advisory: NUNCA vira fileError/bloqueio.
  assert.equal(res.summary!.fileErrors.length, 0, "a11y não bloqueia");
  assert.equal(entries.get("templates/index.html")!.gateOk, true);
  assert.equal(entries.get("Main.java")!.gateOk, true);
});

test("runProjectSmoke: não-python retorna cedo, sem post", async () => {
  const { task } = makeTask([{ path: "Main.java", content: "class Main {}" }]);
  const { deps, posts } = makeDeps(task, { testEnabled: true });
  await new ProjectGateRunner(deps).runProjectSmoke("java", "task-test");
  assert.equal(posts.length, 0);
});

test("runProjectSmoke ts: SEM suíte gerada (nenhum *.test/*.spec) → retorna cedo, sem post", async () => {
  const { task } = makeTask([{ path: "src/app.ts", content: "export const x = 1;" }, { path: "package.json", content: '{"devDependencies":{"vitest":"*"}}' }]);
  const { deps, posts } = makeDeps(task, { testEnabled: true });
  await new ProjectGateRunner(deps).runProjectSmoke("typescript", "task-test");
  assert.equal(posts.length, 0, "sem arquivo de teste, o smoke nem tenta rodar");
});

test("runProjectSmoke ts: COM suíte mas SEM node_modules no workspace → notice 'noRunner' (advisory), não spawna", async () => {
  const { task } = makeTask([{ path: "src/sum.test.ts", content: "import { it } from 'vitest'; it('x', () => {});" }, { path: "package.json", content: '{"devDependencies":{"vitest":"*"}}' }]);
  const { deps, posts } = makeDeps(task, { testEnabled: true });
  // workspaceRoot undefined (default no makeDeps) → sem node_modules → degrada para advisory sem spawnar.
  await new ProjectGateRunner(deps).runProjectSmoke("typescript", "task-test");
  const notice = posts.find((p) => p.type === "stream/notice");
  assert.ok(notice, "posta um aviso advisory");
  assert.equal(notice.level, "info");
  assert.match(notice.message, /runner|vitest\/jest/i);
});

test("reconcile: desligado (reconcileDependencies=false) é no-op", async () => {
  const { task } = makeTask([{ path: "requirements.txt", content: "flask\n" }, { path: "app.py", content: "import flask" }]);
  const { deps, posts } = makeDeps(task, { reconcileDependencies: false });
  new ProjectGateRunner(deps).reconcile();
  assert.equal(posts.length, 0);
});

// --- #05: gate TS bloqueante — PROVA AO VIVO (a armadilha) --------------------------------------------
// Roda o tsc REAL do workspace (node_modules/typescript do próprio repo) contra uma árvore materializada.
// (1) um import RELATIVO fantasma BLOQUEIA (drift interno real, análogo do import-fantasma do mypy); (2) um
// import BARE de terceiros (sem node_modules na árvore temp) NÃO falso-bloqueia. Sem esta prova, promover o
// TS a bloqueante repetiria o falso-bloqueio do Go. tsc é determinístico; o código TS2307 é estável entre versões.

test("run TS (ao vivo): import relativo fantasma (TS2307) BLOQUEIA o arquivo", async () => {
  const { task, entries } = makeTask([{ path: "src/app.ts", content: "import { thing } from './missing';\nconsole.log(thing);\n" }]);
  const { deps } = makeDeps(task, { definitionOfDone: false });
  deps.workspaceRoot = () => process.cwd(); // o repo do forge tem typescript em node_modules → resolveGateTsc acha
  const res = await new ProjectGateRunner(deps).run("typescript", "hexagonal", true);
  assert.ok(res.summary, "TS devolve summary");
  assert.ok(res.summary!.fileErrors.some((f) => /app\.ts$/.test(f.path)), "import relativo fantasma → TS2307 → BLOQUEIA");
  assert.equal(entries.get("src/app.ts")!.gateOk, false, "o arquivo com módulo-fantasma não pode aplicar");
});

test("run TS (ao vivo): import BARE de terceiros NÃO falso-bloqueia (ruído filtrado)", async () => {
  // Import de VALOR (não side-effect) — só ele emite TS2307, então o filtro bare é DE FATO exercitado (achado da revisão).
  const { task, entries } = makeTask([{ path: "src/app.ts", content: "import express from 'express';\nexport const x = express;\n" }]);
  const { deps } = makeDeps(task, { definitionOfDone: false });
  deps.workspaceRoot = () => process.cwd();
  const res = await new ProjectGateRunner(deps).run("typescript", "hexagonal", true);
  assert.ok(res.summary);
  assert.equal(res.summary!.advisory, false, "o tsc RODOU de fato (não degradou a advisory)"); // guarda anti-vácuo
  assert.equal(res.summary!.fileErrors.some((f) => /app\.ts$/.test(f.path)), false, "TS2307 de import bare (terceiros) é filtrado → NÃO bloqueia");
  assert.equal(entries.get("src/app.ts")!.gateOk, true);
});

test("run TS (ao vivo): import de ASSET relativo (./App.css) NÃO falso-bloqueia — React SPA legítimo", async () => {
  // Import de VALOR de asset — emite TS2307 relativo que a exclusão de asset DEVE manter advisory (achado da revisão).
  const { task, entries } = makeTask([{ path: "src/App.tsx", content: "import styles from './App.css';\nexport const App = () => styles;\n" }]);
  const { deps } = makeDeps(task, { definitionOfDone: false });
  deps.workspaceRoot = () => process.cwd();
  const res = await new ProjectGateRunner(deps).run("typescript", "hexagonal", true);
  assert.ok(res.summary);
  assert.equal(res.summary!.advisory, false, "o tsc RODOU de fato");
  assert.equal(res.summary!.fileErrors.some((f) => /App\.tsx$/.test(f.path)), false, "import de .css é asset → advisory, não bloqueia");
  assert.equal(entries.get("src/App.tsx")!.gateOk, true);
});

test("run TS (ao vivo): import a arquivo PARCIAL conhecido NÃO falso-bloqueia (geração incremental)", async () => {
  // main.ts importa ./lib, mas lib.ts é PARCIAL → não é materializado na árvore temp → tsc emite TS2307. Mas
  // lib.ts É uma proposta conhecida → não é drift → advisory (o falso-bloqueio de correção que a revisão pegou).
  const { task, entries } = makeTask([
    { path: "src/main.ts", content: "import { helper } from './lib';\nexport const r = helper();\n" },
    { path: "src/lib.ts", content: "export const helper = () => 1;\n", partial: true },
  ]);
  const { deps } = makeDeps(task, { definitionOfDone: false });
  deps.workspaceRoot = () => process.cwd();
  const res = await new ProjectGateRunner(deps).run("typescript", "hexagonal", true);
  assert.ok(res.summary);
  assert.equal(res.summary!.fileErrors.some((f) => /main\.ts$/.test(f.path)), false, "import a arquivo parcial/aplicado conhecido não é drift → não bloqueia");
  assert.equal(entries.get("src/main.ts")!.gateOk, true);
});

// #08 do survey: o gate TS era NO-OP em .js/.jsx (tsconfig só incluía .ts/.tsx) — JS gerado quebrado passava
// "tsc ok". Com allowJs+checkJs:false o tsc PARSEIA o JS e a SINTAXE (TS1xxx) bloqueia; sem tipar (checkJs:false)
// o JS válido idiomático NÃO falso-bloqueia (validado ao vivo: checkJs:true inundaria de TS2875/implicit-any).
test("run TS (ao vivo): .js com erro de SINTAXE BLOQUEIA (o gate não é mais no-op em JS)", async () => {
  const { task, entries } = makeTask([{ path: "src/app.js", content: "export function f(a, b) { return a + ; }\n" }]);
  const { deps } = makeDeps(task, { definitionOfDone: false });
  deps.workspaceRoot = () => process.cwd();
  const res = await new ProjectGateRunner(deps).run("typescript", "hexagonal", true);
  assert.ok(res.summary);
  assert.ok(res.summary!.fileErrors.some((f) => /app\.js$/.test(f.path)), ".js com sintaxe quebrada (TS1xxx) → BLOQUEIA");
  assert.equal(entries.get("src/app.js")!.gateOk, false);
});

test("run TS (ao vivo): .js/.jsx idiomático limpo NÃO falso-bloqueia (checkJs:false evita o ruído de tipo)", async () => {
  const { task, entries } = makeTask([
    { path: "src/server.js", content: "const express = require('express');\nconst app = express();\napp.get('/', (req, res) => res.json({ ok: true }));\napp.listen(3000);\n" },
    { path: "src/App.jsx", content: "import React from 'react';\nexport const App = () => <div className=\"x\">hi</div>;\n" },
  ]);
  const { deps } = makeDeps(task, { definitionOfDone: false });
  deps.workspaceRoot = () => process.cwd();
  const res = await new ProjectGateRunner(deps).run("typescript", "hexagonal", true);
  assert.ok(res.summary);
  assert.equal(res.summary!.advisory, false, "o tsc RODOU (não degradou) — guarda anti-vácuo");
  assert.equal(res.summary!.fileErrors.some((f) => /server\.js$|App\.jsx$/.test(f.path)), false, "JS/JSX válido não bloqueia (só sintaxe bloqueia, tipo não)");
  assert.equal(entries.get("src/server.js")!.gateOk, true);
  assert.equal(entries.get("src/App.jsx")!.gateOk, true);
});

// --- SAST-TS PROMOVIDO A BLOQUEANTE (paridade com o bandit) -------------------------------------------
// O SAST-TS agora honra o `securityMode` do config (antes ficava "advisory" fixo). Validado por medição ao
// vivo do scanSast sobre 259 arquivos GERADOS por LLM (0 FP na track natural). O arquivo é TS VÁLIDO, então o
// tsc não adiciona bloqueio próprio — o único bloqueio vem do SAST (securityErrors), isolando a promoção.
const SAST_VULN = "import { execSync } from \"child_process\";\nexport function run(expr: string, dir: string): unknown {\n  const a = eval(expr);\n  const b = execSync(\"rm -rf \" + dir);\n  return [a, b];\n}\n";

test("run TS: SAST em modo CONSERVADOR BLOQUEIA eval(input)+execSync dinâmico (code-exec/shell-exec)", async () => {
  const { task, entries } = makeTask([{ path: "src/run.ts", content: SAST_VULN }]);
  const { deps, posts } = makeDeps(task, { definitionOfDone: false, securityGate: "conservative" });
  deps.workspaceRoot = () => process.cwd();
  const res = await new ProjectGateRunner(deps).run("typescript", "hexagonal", true);
  assert.ok(res.summary, "TS devolve summary");
  const secErr = res.summary!.securityErrors ?? [];
  assert.ok(secErr.some((e) => /run\.ts$/.test(e.path)), "eval/execSync dinâmico → securityErrors (bloqueante)");
  assert.equal(entries.get("src/run.ts")!.gateOk, false, "modo conservador FECHA o Aplicar do arquivo com code-exec/shell-exec");
  // O post project/gate carrega os securityErrors em `files` (mesmo canal do bandit).
  const gatePost = posts.find((p) => p.type === "project/gate");
  assert.ok(gatePost?.files.some((f: any) => /run\.ts$/.test(f.path)), "o cartão do arquivo reflete o bloqueio de segurança");
});

test("run TS: SAST em modo ADVISORY NÃO bloqueia — vira securityAdvisories", async () => {
  const { task, entries } = makeTask([{ path: "src/run.ts", content: SAST_VULN }]);
  const { deps } = makeDeps(task, { definitionOfDone: false, securityGate: "advisory" });
  deps.workspaceRoot = () => process.cwd();
  const res = await new ProjectGateRunner(deps).run("typescript", "hexagonal", true);
  assert.ok(res.summary);
  assert.equal((res.summary!.securityErrors ?? []).length, 0, "advisory não produz bloqueio");
  assert.ok((res.summary!.securityAdvisories ?? []).length >= 2, "os mesmos achados viram advisory (eval + execSync)");
  assert.equal(entries.get("src/run.ts")!.gateOk, true, "advisory: o arquivo aplica");
});

// Guard de CI da LIÇÃO-MÃE: código TS LIMPO e idiomático (exatamente os idiomas que já causaram FP —
// método `eval` de interpretador, page.$eval, db.exec, RegExp.exec, execFile com array, texto de template
// mencionando eval, innerHTML de comparação) NÃO pode bloquear sob o modo conservador (o default de produção).
// Sem este teste, um FP bloqueante de scanSast sobre TS válido passaria despercebido (os demais testes TS
// naturais rodam com securityGate default "off").
const SAST_CLEAN = [
  'import { execFile } from "node:child_process";',
  'import Database from "better-sqlite3";',
  'export interface Expr { eval(env: unknown): number; }',
  'export class Lit implements Expr {',
  '  constructor(private v: number) {}',
  '  eval(): number { return this.v; }',
  '}',
  'const db = new Database("app.db");',
  'db.exec("CREATE TABLE IF NOT EXISTS t (id INTEGER)");',
  'export function cloneRepo(url: string): void { execFile("git", ["clone", url]); }',
  'export async function scrape(page: any): Promise<string | null> { return page.$eval("#t", (el: any) => el.textContent); }',
  'const RE = /(\\w+)=(\\w+)/g;',
  'export function parse(line: string) { return RE.exec(line); }',
  'const help = `nunca use eval() com input do usuário`;',
  'export function isEmpty(el: any): boolean { return el.innerHTML === ""; }',
  'export const _h = help;',
].join("\n");

test("run TS: código LIMPO idiomático NÃO bloqueia sob conservador (guard anti-FP da lição-mãe)", async () => {
  const { task, entries } = makeTask([{ path: "src/interp.ts", content: SAST_CLEAN }]);
  const { deps } = makeDeps(task, { definitionOfDone: false, securityGate: "conservative" });
  deps.workspaceRoot = () => process.cwd();
  const res = await new ProjectGateRunner(deps).run("typescript", "hexagonal", true);
  assert.ok(res.summary);
  assert.equal((res.summary!.securityErrors ?? []).length, 0, "TS idiomático limpo → ZERO securityError bloqueante");
  assert.equal((res.summary!.securityAdvisories ?? []).length, 0, "e ZERO advisory (nenhum dos idiomas seguros é sinalizado)");
  assert.equal(entries.get("src/interp.ts")!.gateOk, true, "aplica normalmente");
});

test("run TS: SAST OFF não roda o scanner (sem erros nem advisories de segurança)", async () => {
  const { task, entries } = makeTask([{ path: "src/run.ts", content: SAST_VULN }]);
  const { deps } = makeDeps(task, { definitionOfDone: false, securityGate: "off" });
  deps.workspaceRoot = () => process.cwd();
  const res = await new ProjectGateRunner(deps).run("typescript", "hexagonal", true);
  assert.ok(res.summary);
  assert.equal((res.summary!.securityErrors ?? []).length, 0, "off: sem bloqueio");
  assert.equal((res.summary!.securityAdvisories ?? []).length, 0, "off: sem advisory de segurança");
  assert.equal(entries.get("src/run.ts")!.gateOk, true, "off: aplica");
});
