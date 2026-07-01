import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { resolveRunCommand } from "../core/Runner";
import { isRenderablePath } from "../shared/protocol";
import { buildPreviewHtml, escapeHtml, isWithinWorkspace } from "../util/previewHtml";

test("isRenderablePath: html/htm/svg sim; py/js/md não", () => {
  assert.ok(isRenderablePath("a.html"));
  assert.ok(isRenderablePath("dir/b.HTM"));
  assert.ok(isRenderablePath("c.svg"));
  assert.ok(!isRenderablePath("d.py"));
  assert.ok(!isRenderablePath("e.js"));
  assert.ok(!isRenderablePath("f.md"));
});

test("resolveRunCommand: .html vira renderable; .py vira template; comando custom vence o preview", () => {
  const r = resolveRunCommand("index.html", {});
  assert.ok("renderable" in r && r.renderable && r.ext === ".html");
  assert.ok("template" in resolveRunCommand("a.py", {}));
  // um comando custom configurado para .html tem prioridade sobre o preview
  assert.ok("template" in resolveRunCommand("index.html", { ".html": "serve {file}" }));
  // extensão sem comando nem preview continua caindo em skippedReason
  assert.ok("skippedReason" in resolveRunCommand("x.foo", {}));
});

test("buildPreviewHtml: injeta CSP estrita (default-src none) + base; preserva conteúdo", () => {
  const html = buildPreviewHtml("vscode-webview://x", "https://base", ".html", "<html><head><title>t</title></head><body>oi</body></html>");
  assert.match(html, /default-src 'none'/);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /<base href="https:\/\/base\/">/);
  assert.match(html, /oi/);
  assert.match(html, /<title>t<\/title>/); // não perde o head original
});

test("buildPreviewHtml: sem <head> envolve num documento mínimo", () => {
  const bare = buildPreviewHtml("cs", "b", ".html", "<div>x</div>");
  assert.match(bare, /<!DOCTYPE html>/);
  assert.match(bare, /<div>x<\/div>/);
});

test("buildPreviewHtml: .html permite script inline (interativo); .svg é INERTE (script-src 'none')", () => {
  const html = buildPreviewHtml("cs", "b", ".html", "<html><head></head><body></body></html>");
  assert.match(html, /script-src cs 'unsafe-inline'/);
  const svg = buildPreviewHtml("cs", "b", ".svg", "<svg><script>alert(1)</script></svg>");
  assert.match(svg, /script-src 'none'/); // svg não executa script
  assert.ok(!/script-src[^;]*unsafe-inline/.test(svg), "svg não deve permitir script inline");
});

test("buildPreviewHtml: CSP fecha rede e navegação (connect/object/frame/form = none)", () => {
  const html = buildPreviewHtml("cs", "b", ".html", "<html><head></head><body></body></html>");
  for (const dir of ["connect-src 'none'", "object-src 'none'", "frame-src 'none'", "form-action 'none'"]) {
    assert.match(html, new RegExp(dir.replace(/[()]/g, "\\$&")));
  }
});

test("buildPreviewHtml: remove <meta CSP> e <base> do artefato antes de injetar os próprios", () => {
  const evil = `<html><head><meta http-equiv="Content-Security-Policy" content="default-src *"><base href="http://evil"></head><body>oi</body></html>`;
  const out = buildPreviewHtml("cs", "https://safe", ".html", evil);
  assert.ok(!/default-src \*/.test(out), "CSP permissivo do usuário removido");
  assert.ok(!/href="http:\/\/evil"/.test(out), "base do usuário removido");
  assert.match(out, /<base href="https:\/\/safe\/">/); // o nosso base prevalece
});

test("isWithinWorkspace: dentro sim; '..' e caminho externo não", () => {
  const ws = path.resolve("/proj");
  assert.ok(isWithinWorkspace(ws, path.join(ws, "a", "b.html")));
  assert.ok(!isWithinWorkspace(ws, path.resolve("/etc/passwd")));
  assert.ok(!isWithinWorkspace(ws, path.resolve(ws, "..", "fora.html")));
});

test("escapeHtml: escapa & < >", () => {
  assert.equal(escapeHtml("a & b < c > d"), "a &amp; b &lt; c &gt; d");
});
