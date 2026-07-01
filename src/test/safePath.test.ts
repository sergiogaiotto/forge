import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { isSafeRelPath, safeWorkspacePath } from "../util/safePath";

test("safeWorkspacePath aceita caminhos contidos e devolve o absoluto", () => {
  const ws = path.resolve("/tmp/ws");
  assert.equal(safeWorkspacePath(ws, "src/a.py"), path.join(ws, "src", "a.py"));
  assert.equal(safeWorkspacePath(ws, "src/./b.py"), path.join(ws, "src", "b.py"));
});

test("safeWorkspacePath RECUSA traversal, absoluto e a própria raiz (retorna null)", () => {
  const ws = path.resolve("/tmp/ws");
  assert.equal(safeWorkspacePath(ws, "../evil.py"), null);
  assert.equal(safeWorkspacePath(ws, "foo/../../../etc/x"), null);
  assert.equal(safeWorkspacePath(ws, "src/../../out.txt"), null);
  assert.equal(safeWorkspacePath(ws, path.resolve("/etc/passwd")), null);
  assert.equal(safeWorkspacePath(ws, ""), null);
  assert.equal(safeWorkspacePath(ws, "."), null); // a própria raiz não é um arquivo
});

test("isSafeRelPath filtra `..` interior, absoluto, drive e UNC", () => {
  assert.equal(isSafeRelPath("src/a.py"), true);
  assert.equal(isSafeRelPath("a/b/c.ts"), true);
  assert.equal(isSafeRelPath("foo/../../../etc/x"), false);
  assert.equal(isSafeRelPath("../x"), false);
  assert.equal(isSafeRelPath("C:/Windows/x"), false);
  assert.equal(isSafeRelPath("\\\\server\\share\\x"), false);
  assert.equal(isSafeRelPath(""), false);
});
