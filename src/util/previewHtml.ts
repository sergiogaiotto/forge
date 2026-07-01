// Montagem do documento de preview (HTML/CSP) — pura e testável, sem dependência de vscode. O
// PreviewService só liga esta função ao WebviewPanel (cspSource + base via asWebviewUri).
//
// CSP ESTRITA: default-src 'none' bloqueia rede externa (fetch/XHR/websocket/beacon) e, explicitamente,
// connect/object/frame/form — egress deny-by-default no preview. Recursos LOCAIS entram via cspSource
// (a partir do <base>). Para .html permitimos script inline (o HTML gerado precisa ser interativo), mas
// ISOLADO: sem rede e sem receptor postMessage no host, um script inline não fala com a extensão. Para
// .svg NÃO permitimos script — um preview de imagem é "visualizar", não "executar".
import * as path from "node:path";

export function buildPreviewHtml(cspSource: string, baseHref: string, ext: string, content: string): string {
  const isSvg = ext === ".svg";
  const scriptSrc = isSvg ? `'none'` : `${cspSource} 'unsafe-inline'`;
  const csp = [
    `default-src 'none'`,
    `img-src ${cspSource} data:`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `script-src ${scriptSrc}`,
    `font-src ${cspSource} data:`,
    `connect-src 'none'`,
    `object-src 'none'`,
    `frame-src 'none'`,
    `form-action 'none'`,
  ].join("; ");
  const head = `<meta http-equiv="Content-Security-Policy" content="${csp}"><base href="${baseHref}/">`;

  if (isSvg) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8">${head}<style>html,body{margin:0;height:100%;display:flex;align-items:center;justify-content:center;background:#1e1e1e}svg{max-width:100%;max-height:100vh}</style></head><body>${content}</body></html>`;
  }
  // Remove um <meta CSP> ou <base> que o próprio artefato traga — evita ambiguidade de política e um
  // <base> do usuário redirecionando recursos. A nossa política/base injetada é a que vale.
  const clean = content
    .replace(/<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi, "")
    .replace(/<base\b[^>]*>/gi, "");
  if (/<head[^>]*>/i.test(clean)) return clean.replace(/<head[^>]*>/i, (h) => `${h}\n${head}`);
  if (/<html[^>]*>/i.test(clean)) return clean.replace(/<html[^>]*>/i, (h) => `${h}\n<head>${head}</head>`);
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${head}</head><body>${clean}</body></html>`;
}

// Contenção no workspace (pura, testável): `abs` deve estar DENTRO de `ws` — nunca "../", nem caminho
// absoluto externo. O PreviewService resolve o realpath ANTES de chamar isto (fecha symlinks que
// apontariam para fora do workspace).
export function isWithinWorkspace(ws: string, abs: string): boolean {
  const rel = path.relative(ws, abs);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}
