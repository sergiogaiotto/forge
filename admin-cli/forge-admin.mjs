#!/usr/bin/env node
// FORGE admin CLI (entry de repositório) — Ed25519 key management e emissão de licenças.
// Delega ao núcleo compartilhado (core.mjs). Resolve os caminhos NO LAYOUT DO REPO:
// chaves em admin-cli/keys, chave pública embutida em src/license/embeddedKey.ts.
// O .exe standalone usa o mesmo core via forge-keygen.mjs (resolução por execPath).
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "./core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const code = runCli(process.argv.slice(2), {
  bin: "node admin-cli/forge-admin.mjs",
  defaultKeysDir: path.join(__dirname, "keys"),
  defaultEmbeddedTarget: path.join(__dirname, "..", "src", "license", "embeddedKey.ts"),
  io: { out: (m) => console.log(m), err: (m) => console.error(m) },
});
process.exit(code);
