import assert from "node:assert/strict";
import { test } from "node:test";
import { EgressBlockedError, EgressEnforcer } from "../net/EgressEnforcer";

const silent = () => undefined;

test("allows hosts on the allowlist", () => {
  const e = new EgressEnforcer({ allowExternal: false, allowedHosts: ["hub-gpus.claro.com.br"] }, silent);
  assert.equal(e.isAllowed("https://hub-gpus.claro.com.br/gpt120/v1/chat/completions"), true);
});

test("blocks external hosts by default (deny-by-default)", () => {
  const e = new EgressEnforcer({ allowExternal: false, allowedHosts: ["hub-gpus.claro.com.br"] }, silent);
  assert.equal(e.isAllowed("https://api.openai.com/v1/chat/completions"), false);
  assert.throws(() => e.assertAllowed("https://evil.example.com"), EgressBlockedError);
});

test("treats private/loopback ranges as in-network", () => {
  const e = new EgressEnforcer({ allowExternal: false, allowedHosts: [] }, silent);
  assert.equal(e.isAllowed("http://localhost:8787/license/activate"), true);
  assert.equal(e.isAllowed("http://10.0.0.5:9000/"), true);
  assert.equal(e.isAllowed("http://192.168.1.10/"), true);
  assert.equal(e.isAllowed("https://oracle.internal/mcp"), true);
});

test("allowExternal opens the gate", () => {
  const e = new EgressEnforcer({ allowExternal: true, allowedHosts: [] }, silent);
  assert.equal(e.isAllowed("https://api.anthropic.com/v1/messages"), true);
});

test("non-URL targets (stdio commands) are not network egress", () => {
  const e = new EgressEnforcer({ allowExternal: false, allowedHosts: [] }, silent);
  assert.equal(e.isAllowed("sqlcl"), true);
});
