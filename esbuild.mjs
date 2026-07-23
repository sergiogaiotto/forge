// esbuild bundle for the FORGE extension host (Node/CommonJS).
// `vscode` is provided by the runtime and must stay external.
import esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production") || process.env.NODE_ENV === "production";

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: {
    extension: "src/extension.ts",
    "duckdb-worker": "src/warehouse/duckdbWorker.ts",
  },
  bundle: true,
  outdir: "dist",
  platform: "node",
  format: "cjs",
  target: "node18",
  sourcemap: !production,
  minify: production,
  external: ["vscode", "@duckdb/node-api", "@duckdb/node-bindings"],
  logLevel: "info",
  define: {
    "process.env.NODE_ENV": JSON.stringify(production ? "production" : "development"),
  },
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("[forge] esbuild watching…");
} else {
  await esbuild.build(options);
  console.log("[forge] extension bundled → dist/extension.js");
}
