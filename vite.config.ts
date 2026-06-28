import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// Builds the React webview into dist/webview as a single, hashless bundle so the
// extension can reference it with stable filenames via webview.asWebviewUri().
export default defineConfig({
  plugins: [react()],
  root: resolve(__dirname, "webview-ui"),
  build: {
    outDir: resolve(__dirname, "dist/webview"),
    emptyOutDir: true,
    sourcemap: false,
    target: "es2020",
    rollupOptions: {
      input: resolve(__dirname, "webview-ui/index.html"),
      output: {
        entryFileNames: "assets/index.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name].[ext]",
      },
    },
  },
});
