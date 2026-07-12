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

test("runProjectSmoke: não-python retorna cedo, sem post", async () => {
  const { task } = makeTask([{ path: "Main.java", content: "class Main {}" }]);
  const { deps, posts } = makeDeps(task, { testEnabled: true });
  await new ProjectGateRunner(deps).runProjectSmoke("java", "task-test");
  assert.equal(posts.length, 0);
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
  const { task, entries } = makeTask([{ path: "src/app.ts", content: "import 'express';\nexport const x: number = 1;\n" }]);
  const { deps } = makeDeps(task, { definitionOfDone: false });
  deps.workspaceRoot = () => process.cwd();
  const res = await new ProjectGateRunner(deps).run("typescript", "hexagonal", true);
  assert.ok(res.summary);
  assert.equal(res.summary!.fileErrors.some((f) => /app\.ts$/.test(f.path)), false, "TS2307 de import bare (terceiros) é filtrado → NÃO bloqueia");
  assert.equal(entries.get("src/app.ts")!.gateOk, true);
});

test("run TS (ao vivo): import de ASSET relativo (./App.css) NÃO falso-bloqueia — React SPA legítimo", async () => {
  const { task, entries } = makeTask([{ path: "src/App.tsx", content: "import './App.css';\nexport const App = () => null;\n" }]);
  const { deps } = makeDeps(task, { definitionOfDone: false });
  deps.workspaceRoot = () => process.cwd();
  const res = await new ProjectGateRunner(deps).run("typescript", "hexagonal", true);
  assert.ok(res.summary);
  // TS2307 relativo a .css é ASSET → advisory, NÃO bloqueia (o tsc não conhece css sem ambient decl, o bundler resolve).
  assert.equal(res.summary!.fileErrors.some((f) => /App\.tsx$/.test(f.path)), false, "import de .css não pode falso-bloquear");
  assert.equal(entries.get("src/App.tsx")!.gateOk, true);
});
