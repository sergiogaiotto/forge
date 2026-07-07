import assert from "node:assert/strict";
import { test } from "node:test";
import { buildGateTsconfig, buildTscInstall, findWorkspaceTscJs } from "../util/nodeEnv";

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

test("buildGateTsconfig: JSON válido, tolerante a deps ausentes (noEmit/skipLibCheck/moduleResolution)", () => {
  const cfg = JSON.parse(buildGateTsconfig());
  assert.equal(cfg.compilerOptions.noEmit, true);
  assert.equal(cfg.compilerOptions.skipLibCheck, true);
  assert.equal(cfg.compilerOptions.moduleResolution, "node");
  assert.equal(cfg.compilerOptions.strict, false); // reduz falso-positivo sem node_modules
  assert.deepEqual(cfg.include, ["**/*.ts", "**/*.tsx"]);
});
