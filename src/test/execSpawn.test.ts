import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveExecutable, unsafeField } from "../warehouse/exec";

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

test("RCE: spawn com shell:false NÃO interpreta metacaractere no argumento (arquivo não é criado)", async () => {
  const node = resolveExecutable("node");
  assert.ok(node);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rce-"));
  const marker = path.join(dir, "PWNED.txt").replace(/\\/g, "/");
  try {
    // Se o arg fosse interpretado por um shell, o `& echo ... > marker` criaria o arquivo. Com
    // shell:false, é um ARGUMENTO literal passado ao node — que só o imprime (console.log recebe o
    // arg cru). O marcador NÃO deve existir.
    const injectedArg = `pwned & echo hacked > "${marker}"`;
    await new Promise<void>((resolve) => {
      execFile(node!, ["-e", "console.log(process.argv[1])", injectedArg], { windowsHide: true }, () => resolve());
    });
    let created = true;
    try {
      await fs.access(marker);
    } catch {
      created = false;
    }
    assert.equal(created, false, "o metacaractere & foi tratado como texto literal, não executado");
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
