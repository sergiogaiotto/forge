import assert from "node:assert/strict";
import { test } from "node:test";
import { buildGateTsconfig, buildTscInstall, detectNodeTestRunner, findWorkspaceTestRunner, findWorkspaceTscJs } from "../util/nodeEnv";

test("findWorkspaceTscJs: acha o tsc.js do workspace quando existe; undefined senão", () => {
  const exists = (p: string) => p === "C:/proj/node_modules/typescript/lib/tsc.js";
  assert.equal(findWorkspaceTscJs("C:/proj", exists), "C:/proj/node_modules/typescript/lib/tsc.js");
  assert.equal(findWorkspaceTscJs("C:/proj/", exists), "C:/proj/node_modules/typescript/lib/tsc.js"); // barra final tolerada
  assert.equal(findWorkspaceTscJs("C:/outro", exists), undefined); // não instalado
  assert.equal(findWorkspaceTscJs(undefined, () => true), undefined); // sem workspace
});

test("buildTscInstall: instala typescript como devDependency", () => {
  assert.equal(buildTscInstall(), "npm install --save-dev typescript");
  assert.equal(buildTscInstall("pnpm"), "pnpm install --save-dev typescript");
});

test("buildGateTsconfig: JSON válido, tolerante a deps ausentes; JS/JSX no include com allowJs+checkJs:false", () => {
  const cfg = JSON.parse(buildGateTsconfig());
  assert.equal(cfg.compilerOptions.noEmit, true);
  assert.equal(cfg.compilerOptions.skipLibCheck, true);
  assert.equal(cfg.compilerOptions.moduleResolution, "node");
  assert.equal(cfg.compilerOptions.strict, false); // reduz falso-positivo sem node_modules
  assert.equal(cfg.compilerOptions.allowJs, true, "parseia JS p/ pegar sintaxe (gate era no-op em .js)");
  assert.equal(cfg.compilerOptions.checkJs, false, "NÃO tipa JS (checkJs:true = ruído sem node_modules)");
  assert.deepEqual(cfg.include, ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs"]);
});

// ---- Smoke TS: detecção do runner + resolução do entry -------------------------

test("detectNodeTestRunner: por devDependencies do package.json (vitest ganha do jest)", () => {
  assert.equal(detectNodeTestRunner(JSON.stringify({ devDependencies: { vitest: "^2.0.0" } }), []), "vitest");
  assert.equal(detectNodeTestRunner(JSON.stringify({ devDependencies: { jest: "^29", "ts-jest": "^29" } }), []), "jest");
  assert.equal(detectNodeTestRunner(JSON.stringify({ dependencies: { vitest: "*" }, devDependencies: { jest: "*" } }), []), "vitest", "vitest tem precedência");
});

test("detectNodeTestRunner: por scripts.test quando não há dep declarada", () => {
  assert.equal(detectNodeTestRunner(JSON.stringify({ scripts: { test: "vitest run" } }), []), "vitest");
  assert.equal(detectNodeTestRunner(JSON.stringify({ scripts: { test: "jest --ci" } }), []), "jest");
});

test("detectNodeTestRunner: fallback pelos imports das suítes (vitest explícito; jest via @jest/globals)", () => {
  assert.equal(detectNodeTestRunner(undefined, ["import { describe, it } from 'vitest';\n"]), "vitest");
  assert.equal(detectNodeTestRunner("{}", ["import { describe } from '@jest/globals';\n"]), "jest");
  assert.equal(detectNodeTestRunner(undefined, ["test('x', () => {});\n"]), undefined, "jest com globals implícitos e sem dep → indeterminado (advisory)");
});

test("detectNodeTestRunner: package.json inválido não lança, cai para os imports", () => {
  assert.equal(detectNodeTestRunner("{ not json", ["import 'vitest';\n"]), "vitest");
  assert.equal(detectNodeTestRunner("{ not json", []), undefined);
});

test("findWorkspaceTestRunner: resolve o entry JS no node_modules do workspace (via node, sem .cmd)", () => {
  const exists = (p: string) => p === "C:/proj/node_modules/vitest/vitest.mjs" || p === "C:/proj/node_modules/jest/bin/jest.js";
  assert.deepEqual(findWorkspaceTestRunner("C:/proj", "vitest", exists), { entry: "C:/proj/node_modules/vitest/vitest.mjs", args: ["run", "--no-color"] });
  assert.deepEqual(findWorkspaceTestRunner("C:/proj/", "jest", exists), { entry: "C:/proj/node_modules/jest/bin/jest.js", args: ["--ci", "--colors=false"] });
  assert.equal(findWorkspaceTestRunner("C:/vazio", "vitest", exists), undefined, "runner não instalado → undefined (smoke advisory)");
  assert.equal(findWorkspaceTestRunner(undefined, "vitest", () => true), undefined, "sem workspace → undefined");
});
