#!/usr/bin/env node
// Constrói o forge-keygen.exe autocontido (Node Single Executable Application).
// Pipeline: esbuild (bundle CJS) → sea-config → blob → postject (injeta no node.exe).
// Resultado: admin-cli/dist/forge-keygen.exe — roda no CMD SEM Node instalado na máquina-alvo.
//
// Uso:  node admin-cli/build-exe.mjs        (atalho: npm run keygen:build-exe)
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import * as esbuild from "esbuild";
import { inject } from "postject";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, "dist");
const ENTRY = path.join(__dirname, "forge-keygen.mjs");
const BUNDLE = path.join(DIST, "forge-keygen.cjs");
const SEA_CONFIG = path.join(DIST, "sea-config.json");
const BLOB = path.join(DIST, "forge-keygen.blob");
const isWin = process.platform === "win32";
const EXE = path.join(DIST, isWin ? "forge-keygen.exe" : "forge-keygen");
// Fuse fixo do Node SEA (constante pública do runtime; NÃO é segredo).
const SENTINEL = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

function step(msg) {
  console.log(`\n▸ ${msg}`);
}

async function main() {
  fs.mkdirSync(DIST, { recursive: true });

  step("Bundle CJS com esbuild");
  await esbuild.build({
    entryPoints: [ENTRY],
    outfile: BUNDLE,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: `node${process.versions.node.split(".")[0]}`,
    // builtins node: ficam externos automaticamente (platform:node); node:sea é resolvido em runtime.
    banner: { js: "// FORGE keygen SEA bundle — gerado por build-exe.mjs. Não editar." },
    logLevel: "info",
  });
  console.log(`  ${path.relative(process.cwd(), BUNDLE)} (${(fs.statSync(BUNDLE).size / 1024).toFixed(1)} KB)`);

  step("Gera o blob SEA");
  fs.writeFileSync(
    SEA_CONFIG,
    JSON.stringify({ main: BUNDLE, output: BLOB, disableExperimentalSEAWarning: true }, null, 2),
  );
  const gen = spawnSync(process.execPath, ["--experimental-sea-config", SEA_CONFIG], {
    stdio: "inherit",
    cwd: __dirname,
  });
  if (gen.status !== 0) {
    console.error("✗ falha ao gerar o blob SEA");
    process.exit(gen.status || 1);
  }

  step("Copia o runtime Node e injeta o blob (postject)");
  fs.copyFileSync(process.execPath, EXE);
  const injectOpts = { sentinelFuse: SENTINEL, overwrite: true };
  if (process.platform === "darwin") injectOpts.machoSegmentName = "NODE_SEA";
  await inject(EXE, "NODE_SEA_BLOB", fs.readFileSync(BLOB), injectOpts);

  if (process.platform === "darwin") {
    // No macOS a injeção invalida a assinatura ad-hoc do node e o AMFI/Gatekeeper RECUSA
    // executar (killed: 9) até re-assinar. É obrigatório, não cosmético.
    spawnSync("codesign", ["--remove-signature", EXE], { stdio: "ignore" });
    const cs = spawnSync("codesign", ["--sign", "-", EXE], { stdio: "inherit" });
    if (cs.status !== 0) {
      console.error(`✗ codesign ad-hoc falhou — o binário não executará no macOS. Rode manualmente: codesign --sign - ${EXE}`);
      process.exit(cs.status || 1);
    }
  }

  const sizeMB = (fs.statSync(EXE).size / (1024 * 1024)).toFixed(1);
  step("Pronto");
  console.log(`  Executável: ${path.relative(process.cwd(), EXE)} (${sizeMB} MB)`);
  console.log(`  Node embutido: v${process.versions.node} (${process.arch})`);
  if (isWin) {
    console.log("  Nota: no Windows a assinatura Authenticode do node.exe fica inválida após a injeção");
    console.log("        (esperado; o binário roda normalmente). Assine com o cert corporativo se for distribuir.");
  } else if (process.platform === "darwin") {
    console.log("  Nota: binário re-assinado ad-hoc (codesign --sign -) — necessário para executar no macOS.");
  }
  console.log("\nTeste rápido no CMD:");
  console.log(`  ${path.relative(process.cwd(), EXE)} --version`);
  console.log(`  ${path.relative(process.cwd(), EXE)} keygen --key-id ed25519-2026-01 --keys-dir .\\keys-teste`);
}

main().catch((e) => {
  console.error("✗ build falhou:", e && e.stack ? e.stack : e);
  process.exit(1);
});
