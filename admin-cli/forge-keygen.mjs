#!/usr/bin/env node
// FORGE keygen — entry STANDALONE (empacotado como forge-keygen.exe via Node SEA).
// Mesmo núcleo (core.mjs) do CLI de repositório, mas com resolução de caminho pensada
// para um binário autocontido distribuído SEM o repositório ao redor:
//   - Rodando como .exe (SEA): as chaves ficam em <pasta-do-exe>/keys.
//   - Rodando o bundle via `node` (teste): as chaves ficam em <cwd>/keys.
//   - `--keys-dir <dir>` sempre sobrepõe.
// Não há repo, então embeddedKey.ts cai ao lado das chaves (o admin copia para o cliente),
// e o keygen SEMPRE imprime a chave pública/key_id para colar no src/license/embeddedKey.ts.
import * as path from "node:path";
import { runCli } from "./core.mjs";

function detectSea() {
  try {
    // node:sea existe no Node 20.12+/22; isSea() = true quando embutido no .exe.
    // Import dinâmico para não quebrar em runtimes sem o módulo.
    // eslint-disable-next-line no-undef
    return require("node:sea").isSea();
  } catch {
    return false;
  }
}

const isSea = detectSea();
const baseDir = isSea ? path.dirname(process.execPath) : process.cwd();

const code = runCli(process.argv.slice(2), {
  bin: "forge-keygen.exe",
  defaultKeysDir: path.join(baseDir, "keys"),
  defaultEmbeddedTarget: null, // standalone: sem layout de repo
  io: { out: (m) => console.log(m), err: (m) => console.error(m) },
});
process.exit(code);
