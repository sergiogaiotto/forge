import assert from "node:assert/strict";
import { test } from "node:test";
import { isEmail, resolveEmailIdentity } from "../util/identity";

test("isEmail valida e-mails", () => {
  assert.equal(isEmail("joao@claro.com.br"), true);
  assert.equal(isEmail("dev@claro.com"), true);
  assert.equal(isEmail("não-email"), false);
  assert.equal(isEmail(""), false);
  assert.equal(isEmail(undefined), false);
});

test("subject é e-mail e admin não exige → coleta automática (license)", () => {
  const r = resolveEmailIdentity({ subject: "joao@claro.com.br", manualEmail: null, requireEmail: false });
  assert.deepEqual(r, { email: "joao@claro.com.br", emailRequired: false, source: "license" });
});

test("e-mail informado manualmente tem precedência", () => {
  const r = resolveEmailIdentity({ subject: "dev@claro.com", manualEmail: "maria@claro.com.br", requireEmail: true });
  assert.equal(r.email, "maria@claro.com.br");
  assert.equal(r.source, "manual");
  assert.equal(r.emailRequired, false);
});

test("subject não é e-mail → e-mail obrigatório no setup", () => {
  const r = resolveEmailIdentity({ subject: "matricula-12345", manualEmail: null, requireEmail: false });
  assert.equal(r.email, null);
  assert.equal(r.emailRequired, true);
  assert.equal(r.source, "none");
});

test("admin exige e-mail (licença compartilhada) → obrigatório mesmo com subject e-mail", () => {
  const r = resolveEmailIdentity({ subject: "dev@claro.com", manualEmail: null, requireEmail: true });
  assert.equal(r.emailRequired, true);
  assert.equal(r.email, null);
});

test("subject ausente → obrigatório", () => {
  const r = resolveEmailIdentity({ subject: undefined, manualEmail: undefined, requireEmail: false });
  assert.equal(r.emailRequired, true);
});
