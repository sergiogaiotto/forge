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

// ---- trustInNetwork (defesa em profundidade contra redirecionamento de egress) ----

test("trustInNetwork ausente = true = retrocompatível (LAN in-network liberada)", () => {
  const e = new EgressEnforcer({ allowExternal: false, allowedHosts: [] }, silent);
  assert.equal(e.isAllowed("http://10.0.0.5:9000/"), true);
  assert.equal(e.isAllowed("https://x.internal/embed"), true);
});

test("trustInNetwork:false exige allowlist para LAN, mas loopback segue liberado", () => {
  const e = new EgressEnforcer({ allowExternal: false, allowedHosts: [], trustInNetwork: false }, silent);
  // loopback (tooling local) SEMPRE ok
  assert.equal(e.isAllowed("http://localhost:11434/v1"), true);
  assert.equal(e.isAllowed("http://127.0.0.1:8787/"), true);
  assert.equal(e.isAllowed("http://[::1]:8080/"), true);
  // LAN/interno agora BLOQUEADO (o vetor de redirecionamento de egress por settings)
  assert.equal(e.isAllowed("http://10.0.0.5:9000/steal"), false);
  assert.equal(e.isAllowed("http://192.168.1.10/"), false);
  assert.equal(e.isAllowed("https://exfil.internal/embed"), false);
  assert.equal(e.isAllowed("https://x.local/"), false);
});

test("trustInNetwork:false ainda libera host de LAN explicitamente na allowlist", () => {
  const e = new EgressEnforcer({ allowExternal: false, allowedHosts: ["oracle.internal"], trustInNetwork: false }, silent);
  assert.equal(e.isAllowed("https://oracle.internal/mcp"), true);
  assert.equal(e.isAllowed("https://outro.internal/mcp"), false);
});

// REGRESSÃO (revisão adversarial): hostname público que só COMEÇA com prefixo de IP NÃO é in-network.
test("REGRESSÃO: hostname público com prefixo de IP não burla o deny-by-default (default e endurecido)", () => {
  const def = new EgressEnforcer({ allowExternal: false, allowedHosts: [] }, silent); // trustInNetwork default
  for (const bad of [
    "http://127.0.0.1.attacker.com/exfil",
    "http://127.attacker.com/steal",
    "http://10.evil.com/steal",
    "http://192.168.evil.com/steal",
    "http://169.254.evil.com/",
    "http://172.16.evil.com/",
  ]) {
    assert.equal(def.isAllowed(bad), false, `${bad} é público — não pode contar como in-network`);
  }
  // IPs LITERAIS legítimos continuam in-network no default
  assert.equal(def.isAllowed("http://127.0.0.1:11434/"), true);
  assert.equal(def.isAllowed("http://10.0.0.5/legit"), true);

  // no modo endurecido, o mesmo host público-com-prefixo-loopback continua bloqueado
  const hard = new EgressEnforcer({ allowExternal: false, allowedHosts: [], trustInNetwork: false }, silent);
  assert.equal(hard.isAllowed("http://127.0.0.1.attacker.com/exfil"), false);
  assert.equal(hard.isAllowed("http://127.0.0.1:8787/"), true, "IP loopback real segue liberado");
});
