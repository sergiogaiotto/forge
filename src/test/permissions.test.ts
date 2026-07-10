import assert from "node:assert/strict";
import { test } from "node:test";
import { PermissionAuditor, PermissionRecord, PermissionService, previewDetail, resolvePermission } from "../security/permissions";
import { ToolApprovalGate } from "../mcp/ToolApprovalGate";
import { McpServerEntry } from "../mcp/types";

test("resolvePermission: política bloqueia SEM perguntar; auto-approve só em leitura; resto pergunta", () => {
  // bloqueio de política tem precedência absoluta (nem auto-approve o contorna)
  assert.equal(resolvePermission({ policyBlocked: true, autoApprove: true, scope: "read" }), "block");
  assert.equal(resolvePermission({ policyBlocked: true, scope: "write" }), "block");
  // auto-approve NUNCA vale para escrita (RF-075 — mesma regra do gate MCP)
  assert.equal(resolvePermission({ autoApprove: true, scope: "read" }), "auto");
  assert.equal(resolvePermission({ autoApprove: true, scope: "write" }), "ask");
  // padrão: pergunta
  assert.equal(resolvePermission({ scope: "read" }), "ask");
  assert.equal(resolvePermission({ scope: "write" }), "ask");
});

test("previewDetail: capa strings longas, serializa objetos, não lança em valor não-serializável", () => {
  assert.equal(previewDetail("abc"), "abc");
  assert.equal(previewDetail("x".repeat(700)).length, 601); // 600 + reticências
  assert.equal(previewDetail({ a: 1 }), '{"a":1}');
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(typeof previewDetail(circular), "string"); // não lança
});

test("PermissionAuditor: ring buffer capado em 500 (os mais antigos saem)", () => {
  const a = new PermissionAuditor();
  for (let i = 0; i < 510; i++) {
    a.record({ kind: "sql.write", action: `a${i}`, scope: "write", outcome: "approved", via: "dialog" });
  }
  const recent = a.recent();
  assert.equal(recent.length, 500);
  assert.equal(recent[0].action, "a10"); // os 10 primeiros saíram
  assert.equal(recent[499].action, "a509");
});

function makeService(dialogAnswer: string | undefined) {
  const auditor = new PermissionAuditor();
  const emitted: PermissionRecord[] = [];
  const dialogs: { message: string; detail: string; label: string }[] = [];
  const svc = new PermissionService(
    auditor,
    (rec) => emitted.push(rec),
    async (message, detail, label) => {
      dialogs.push({ message, detail, label });
      return dialogAnswer;
    }
  );
  return { svc, auditor, emitted, dialogs };
}

test("PermissionService.confirm: aprovado quando o dev clica o rótulo; registro + emissão obs", async () => {
  const { svc, auditor, emitted, dialogs } = makeService("Executar escrita");
  const ok = await svc.confirm({ kind: "sql.write", action: 'conexão "dw": escrita', subject: "dw", scope: "write", detail: "DELETE FROM t WHERE id=1" }, { confirmLabel: "Executar escrita" });
  assert.equal(ok, true);
  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0].message, /^FORGE · /);
  assert.equal(dialogs[0].label, "Executar escrita");
  assert.equal(auditor.recent().length, 1);
  assert.equal(auditor.recent()[0].outcome, "approved");
  assert.equal(auditor.recent()[0].via, "dialog");
  assert.equal(emitted.length, 1); // toda decisão vira evento obs
  assert.equal(emitted[0].kind, "sql.write");
});

test("PermissionService.confirm: cancelar/fechar o diálogo NEGA (undefined ou outro rótulo)", async () => {
  const { svc, auditor } = makeService(undefined);
  const ok = await svc.confirm({ kind: "sql.write", action: "escrita", scope: "write" }, { confirmLabel: "Executar escrita" });
  assert.equal(ok, false);
  assert.equal(auditor.recent()[0].outcome, "denied");
});

test("PermissionService.confirm: política bloqueia SEM abrir diálogo; auto-approve leitura idem", async () => {
  const blocked = makeService("Permitir");
  const okB = await blocked.svc.confirm({ kind: "contract.unverified", action: "aplicar", scope: "write" }, { policyBlocked: true });
  assert.equal(okB, false);
  assert.equal(blocked.dialogs.length, 0); // nunca perguntou
  assert.equal(blocked.auditor.recent()[0].outcome, "blocked");
  assert.equal(blocked.auditor.recent()[0].via, "policy");

  const auto = makeService("Permitir");
  const okA = await auto.svc.confirm({ kind: "mcp.tool", action: "srv.tool", scope: "read" }, { autoApprove: true });
  assert.equal(okA, true);
  assert.equal(auto.dialogs.length, 0);
  assert.equal(auto.auditor.recent()[0].outcome, "auto");
});

test("PermissionService.note: registra decisão de outra superfície (webview) com detail capado", () => {
  const { svc, auditor, emitted } = makeService(undefined);
  svc.note({ kind: "proposal.force", action: "aplicar por cima do gate", subject: "a.py", scope: "write", detail: "x".repeat(2000) }, "approved", "webview");
  assert.equal(auditor.recent().length, 1);
  assert.equal(auditor.recent()[0].via, "webview");
  assert.ok((auditor.recent()[0].detail ?? "").length <= 601);
  assert.equal(emitted.length, 1);
});

test("ToolApprovalGate: hook onDecision dispara no auto-approve E no prompt (aprovado/negado)", async () => {
  const decisions: { outcome: string; scope: string }[] = [];
  const hook = (rec: { outcome: "auto" | "approved" | "denied"; scope: "readonly" | "readwrite" }) => decisions.push({ outcome: rec.outcome, scope: rec.scope });
  const server: McpServerEntry = { id: "srv", transport: "streamableHttp", url: "https://mcp.interno/mcp", scope: "readonly", autoApprove: true, enabled: true };

  // auto-approve (readonly): antes era só log — agora entra no trail
  const gateAuto = new ToolApprovalGate(async () => true, hook);
  assert.equal(await gateAuto.requireApproval(server, "query", "readonly", { q: 1 }), true);
  assert.deepEqual(decisions.pop(), { outcome: "auto", scope: "readonly" });

  // readwrite NUNCA auto-aprova — vai ao prompt; hook registra o desfecho
  assert.equal(await gateAuto.requireApproval(server, "write", "readwrite", {}), true);
  assert.deepEqual(decisions.pop(), { outcome: "approved", scope: "readwrite" });

  const gateDeny = new ToolApprovalGate(async () => false, hook);
  assert.equal(await gateDeny.requireApproval({ ...server, autoApprove: false }, "query", "readonly", {}), false);
  assert.deepEqual(decisions.pop(), { outcome: "denied", scope: "readonly" });
});
