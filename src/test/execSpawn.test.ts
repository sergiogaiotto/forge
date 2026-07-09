import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildSpawn, resolveExecutable, unsafeField } from "../warehouse/exec";

// ---- resolveExecutable (puro) ----

test("resolveExecutable: encontra 'node' no PATH; retorna null para inexistente", () => {
  const node = resolveExecutable("node");
  assert.ok(node, "node deve estar no PATH do CI/host");
  assert.ok(path.isAbsolute(node!));
  assert.equal(resolveExecutable("binario-que-nao-existe-xyz-123"), null);
});

test("resolveExecutable: caminho explícito só resolve se existir", () => {
  const node = resolveExecutable("node")!;
  assert.equal(resolveExecutable(node), node); // caminho absoluto existente
  assert.equal(resolveExecutable("/caminho/que/nao/existe/foo"), null);
});

test("resolveExecutable: honra PATHEXT injetado no Windows", () => {
  // Sem tocar o SO real: injeta um PATH/PATHEXT falsos — como o dir não existe, resolve null,
  // provando que a resolução usa o env injetado (não o global).
  assert.equal(resolveExecutable("qualquer", { PATH: "C:/naoexiste", PATHEXT: ".EXE" }, "win32"), null);
});

test("unsafeField: rejeita metacaracteres de shell; aceita string de conexão normal", () => {
  assert.ok(unsafeField("x & echo pwned"));
  assert.ok(unsafeField("a | b"));
  assert.ok(unsafeField("$(whoami)"));
  assert.ok(unsafeField("a > file"));
  assert.ok(!unsafeField("postgresql://app@db:5432/prod"));
  assert.ok(!unsafeField("user@DWPROD"));
  assert.ok(!unsafeField(undefined));
});

// ---- SPAWN REAL: a correção de RCE não interpreta metacaractere (o teste que faltava) ----

test("buildSpawn: .exe/POSIX usa shell:false; shim .bat/.cmd no Windows usa shell com args quotados", () => {
  assert.deepEqual(buildSpawn("/usr/bin/psql", ["--csv", "-f", "/tmp/q.sql"], "linux"), {
    file: "/usr/bin/psql",
    args: ["--csv", "-f", "/tmp/q.sql"],
    useShell: false,
  });
  const shim = buildSpawn("C:/Program Files/oracle/sql.cmd", ["-s", "@/tmp/w.sql"], "win32");
  assert.equal(shim.useShell, true);
  assert.equal(shim.file, '"C:/Program Files/oracle/sql.cmd"'); // caminho quotado (espaço)
  assert.deepEqual(shim.args, ['"-s"', '"@/tmp/w.sql"']);
  // .exe no Windows NÃO é shim → shell:false
  assert.equal(buildSpawn("C:/nodejs/node.exe", ["-e", "1"], "win32").useShell, false);
});

test("RCE: metacaractere NÃO é interpretado E o argumento chega literal ao processo (não-vacuous)", async () => {
  const node = resolveExecutable("node");
  assert.ok(node);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rce-"));
  const marker = path.join(dir, "PWNED.txt").replace(/\\/g, "/");
  try {
    const injectedArg = `pwned & echo hacked > "${marker}"`;
    // Captura o stdout E rejeita em erro de spawn: prova que o node REALMENTE rodou e recebeu o arg
    // como um único token literal (não-vacuous — antes o teste passava mesmo se o filho nem rodasse).
    const out = await new Promise<string>((resolve, reject) => {
      execFile(node!, ["-e", "process.stdout.write(process.argv[1])", injectedArg], { windowsHide: true }, (err, stdout) =>
        err ? reject(err) : resolve(String(stdout))
      );
    });
    assert.equal(out, injectedArg, "o node recebeu o arg com '&' como texto literal (não dividido por shell)");
    let created = true;
    try {
      await fs.access(marker);
    } catch {
      created = false;
    }
    assert.equal(created, false, "o metacaractere & não foi executado");
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

// Windows-only: prova que um SHIM .cmd de verdade RODA via buildSpawn (shell:false lançaria EINVAL) e
// que o metacaractere continua não sendo interpretado. Fecha o gap do teste anterior (só node.exe).
test("RCE (Windows): shim .cmd roda via buildSpawn e não interpreta metacaractere", { skip: process.platform !== "win32" }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shim "));
  const shim = path.join(dir, "tool.cmd");
  const marker = path.join(dir, "PWNED.txt").replace(/\\/g, "/");
  try {
    await fs.writeFile(shim, "@echo off\r\necho GOT=[%1]\r\n", "utf8");
    const injectedArg = `x & echo hacked > "${marker}"`;
    const plan = buildSpawn(shim, [injectedArg], "win32");
    const out = await new Promise<string>((resolve) => {
      execFile(plan.file, plan.args, { windowsHide: true, shell: plan.useShell }, (_e, stdout) => resolve(String(stdout || "")));
    });
    assert.match(out, /GOT=\[/, "o .cmd EXECUTOU (shell:false teria lançado EINVAL)");
    let created = true;
    try {
      await fs.access(marker);
    } catch {
      created = false;
    }
    assert.equal(created, false, "o & não virou comando separado (quotado)");
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("RCE: caminho com ESPAÇO no wrapper não quebra sob shell:false (Node quota o arg)", async () => {
  const node = resolveExecutable("node");
  assert.ok(node);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sp ace-"));
  const scriptFile = path.join(dir, "with space.js");
  try {
    await fs.writeFile(scriptFile, "process.stdout.write('ok-espaco')", "utf8");
    const out = await new Promise<string>((resolve) => {
      execFile(node!, [scriptFile], { windowsHide: true }, (_e, stdout) => resolve(String(stdout)));
    });
    assert.match(out, /ok-espaco/, "caminho com espaço executa (Node quota; não divide no espaço)");
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});
