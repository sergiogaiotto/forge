import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const testDir = resolve("src", "test");
const files = readdirSync(testDir)
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => resolve(testDir, name));

if (files.length === 0) {
  console.error("Nenhum arquivo src/test/*.test.ts encontrado.");
  process.exit(1);
}

const tsxCli = resolve("node_modules", "tsx", "dist", "cli.mjs");
const result = spawnSync(process.execPath, [tsxCli, "--test", ...files], {
  stdio: "inherit",
  env: process.env,
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
