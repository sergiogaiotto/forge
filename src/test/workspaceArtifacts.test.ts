import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractEnvVariableNames,
  mergeEnvExample,
  mergeGitignore,
  recommendedGitignoreEntries,
} from "../util/workspaceArtifacts";

test("extractEnvVariableNames cobre Python, JS, Java, .NET, Rust e interpolacao", () => {
  const names = extractEnvVariableNames([
    'os.getenv("OPENAI_API_KEY")\nos.environ["DB_URL"]',
    "process.env.PORT; process.env['JWT_SECRET']; import.meta.env.VITE_API_URL",
    'System.getenv("JAVA_HOME"); Environment.GetEnvironmentVariable("ASPNETCORE_ENVIRONMENT")',
    'std::env::var("RUST_LOG"); ENV["RAILS_ENV"]; url: "${WAREHOUSE_URL:-local}"',
  ]);
  assert.deepEqual(names, [
    "ASPNETCORE_ENVIRONMENT",
    "DB_URL",
    "JAVA_HOME",
    "JWT_SECRET",
    "OPENAI_API_KEY",
    "PORT",
    "RAILS_ENV",
    "RUST_LOG",
    "VITE_API_URL",
    "WAREHOUSE_URL",
  ]);
});

test("mergeEnvExample preserva conteudo e acrescenta apenas nomes ausentes sem valores", () => {
  const merged = mergeEnvExample("# existente\r\nPORT=3000\r\n", ["PORT", "OPENAI_API_KEY"]);
  assert.deepEqual(merged.added, ["OPENAI_API_KEY"]);
  assert.match(merged.content, /PORT=3000\r\nOPENAI_API_KEY=\r\n$/);

  const fresh = mergeEnvExample(undefined, ["B", "A"]);
  assert.deepEqual(fresh.added, ["A", "B"]);
  assert.match(fresh.content, /^# Variaveis detectadas/);
  assert.match(fresh.content, /A=\nB=\n$/);
});

test("mergeGitignore e idempotente e adapta entradas a stack", () => {
  const recommended = recommendedGitignoreEntries({ python: true, node: true });
  assert.ok(recommended.includes(".venv/"));
  assert.ok(recommended.includes("node_modules/"));
  assert.ok(recommended.includes("!.env.example"));

  const once = mergeGitignore("dist/\n", recommended);
  assert.ok(!once.added.includes("dist/"));
  assert.ok(once.added.includes(".venv/"));
  const twice = mergeGitignore(once.content, recommended);
  assert.deepEqual(twice.added, []);
  assert.equal(twice.content, once.content);
});
