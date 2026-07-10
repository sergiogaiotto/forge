import assert from "node:assert/strict";
import { test } from "node:test";
import { localizedProviderPresets, PROVIDER_PRESETS } from "../api/presets";
import { getHostLocale, hostT, setHostLocale } from "../i18n";
import { HOST_MESSAGES, HostMessageKey } from "../i18n/hostMessages";
import { SUPPORTED_LOCALES } from "../shared/locale";

test("hostT: serve INGLÊS a um usuário en (o que o vscode.l10n nativo NÃO conseguiria com fonte pt-BR)", () => {
  setHostLocale("en");
  assert.equal(getHostLocale(), "en");
  assert.equal(hostT("dialog.skillsReindexed"), "FORGE: skills reindexed.");
  assert.equal(hostT("notice.noBlueprint"), "No approved blueprint. Plan the project first.");
  setHostLocale("pt-BR");
  assert.equal(hostT("dialog.skillsReindexed"), "FORGE: skills reindexadas.");
  assert.equal(hostT("notice.charterSaved"), "Charter salvo em .forge/project.md (injetado em todo prompt).");
});

test("hostT: chave inexistente cai na própria chave (buraco visível, nunca vazio)", () => {
  setHostLocale("en");
  assert.equal(hostT("nao.existe" as HostMessageKey), "nao.existe");
  setHostLocale("pt-BR");
});

test("catálogo host: TODO locale cobre TODAS as chaves do pt-BR e nenhuma string vazia", () => {
  const ptKeys = Object.keys(HOST_MESSAGES["pt-BR"]).sort();
  for (const loc of SUPPORTED_LOCALES) {
    if (loc === "pt-BR") continue;
    assert.deepEqual(Object.keys(HOST_MESSAGES[loc]).sort(), ptKeys, `pt-BR e ${loc} devem ter exatamente as mesmas chaves`);
  }
  assert.ok(ptKeys.length >= 6, `esperado >=6 chaves no piloto, achei ${ptKeys.length}`);
  for (const loc of SUPPORTED_LOCALES) {
    for (const [k, v] of Object.entries(HOST_MESSAGES[loc])) assert.ok(v && v.length > 0, `${loc}.${k} vazio`);
  }
});

test("hostT: es traduz (PR 11 — a arquitetura escala adicionando um catálogo)", () => {
  setHostLocale("es");
  assert.equal(hostT("notice.license.activated"), "Licencia activada.");
  assert.equal(hostT("gate.py.ok"), "Gate en verde: el conjunto compila e importa (compileall + mypy sin errores de contrato).");
  assert.equal(hostT("par.diffs", { count: 1, total: 9 }), "❌ **1 divergencia** en 9 métricas:");
  assert.match(hostT("card.sql.openFile"), /\/ejecutar-sql/); // texto es cita o LABEL es do comando
  setHostLocale("pt-BR");
});

// REGRESSÃO (revisão adversarial do PR6): o Onboarding en exibia pt-BR vindo do HOST cru pelo protocolo
// (preset.note sob o campo API Key — visível em TODO onboarding default — e a mensagem do teste de
// embeddings no modo lexical). Protocolo transporta string PRONTA: o host resolve por locale no post.
test("localizedProviderPresets: note resolvida no locale do host; a fonte não carrega literal", () => {
  // a fonte (PROVIDER_PRESETS) não tem note — o texto mora no catálogo (uma fonte só, sem drift)
  for (const p of PROVIDER_PRESETS) assert.equal(p.note, undefined, `preset ${p.id} com note literal na fonte`);
  setHostLocale("en");
  const en = Object.fromEntries(localizedProviderPresets().map((p) => [p.id, p.note]));
  assert.equal(en["hubgpu-120b"], "The proxy authenticates by other means (network / SSO).");
  assert.equal(en["openai"], "Requires an OpenAI API key (external egress must be allowed).");
  assert.equal(en["anthropic"], "Native Messages format. Requires an Anthropic API key.");
  setHostLocale("pt-BR");
  const pt = Object.fromEntries(localizedProviderPresets().map((p) => [p.id, p.note]));
  assert.equal(pt["hubgpu-120b"], "O proxy autentica por outra via (rede / SSO).");
  assert.equal(pt["hubgpu-20b"], pt["hubgpu-120b"]); // os dois HubGPU compartilham a nota
  // campos NÃO traduzíveis intactos
  assert.equal(localizedProviderPresets()[0].baseUrl, PROVIDER_PRESETS[0].baseUrl);
});

test("rag.test.*: mensagens do teste de embeddings traduzem no host (o modo lexical era o vão)", () => {
  setHostLocale("en");
  assert.equal(hostT("rag.test.lexical"), "No embeddings endpoint — lexical retrieval (BM25).");
  assert.equal(hostT("rag.test.disabled"), "RAG disabled.");
  assert.equal(hostT("rag.test.ok", { dims: 1024 }), "Embeddings OK (1024 dims).");
  setHostLocale("pt-BR");
  assert.equal(hostT("rag.test.lexical"), "Sem endpoint de embeddings — recuperação lexical (BM25).");
  assert.equal(hostT("rag.test.ok", { dims: 1024 }), "Embeddings OK (1024 dims).");
});

// PR8 (i18n do host): amostra das superfícies novas — notices, planStep, gate, smoke, cards — traduz
// em en e mantém pt-BR byte-idêntico ao literal antigo (o pt é a fonte; os testes rodam no default).
test("PR8: notices/gate/smoke/cards resolvem por locale (pt fonte intacta; en traduz)", () => {
  setHostLocale("pt-BR");
  assert.equal(hostT("notice.applyAll", { parts: "2 aplicado(s)" }), "Aplicar tudo: 2 aplicado(s).");
  assert.equal(hostT("gate.py.failed", { count: 3 }), 'Gate reprovou: 3 arquivo(s) não compilam/importam. O "Aplicar" deles está bloqueado até corrigir.');
  assert.equal(hostT("smoke.passed", { count: 7 }), "Smoke test: 7 teste(s) gerado(s) PASSARAM no venv do workspace — o projeto de fato roda, não só compila.");
  assert.ok(hostT("card.git.untrusted").includes("não é confiável"));
  assert.equal(hostT("bp.step.analyze"), "Analisando os requisitos e desenhando a arquitetura…");
  setHostLocale("en");
  assert.equal(hostT("notice.applyAll", { parts: "2 applied" }), "Apply all: 2 applied.");
  assert.match(hostT("gate.py.failed", { count: 3 }), /^Gate failed: 3 file/);
  assert.match(hostT("smoke.passed", { count: 7 }), /7 generated test\(s\) PASSED/);
  assert.ok(hostT("card.git.untrusted").includes("not trusted"));
  assert.match(hostT("card.sql.openFile"), /\/run-sql/); // texto en cita o LABEL en do comando
  assert.equal(hostT("bp.step.analyze"), "Analyzing the requirements and designing the architecture…");
  setHostLocale("pt-BR");
});

// PR9 (i18n dos módulos host): amostra dos renderers puros — git, warehouse, paridade, anti-padrões,
// impacto dbt, PII — traduz em en e mantém pt-BR byte-idêntico (a fonte não muda; testes rodam no default).
test("PR9: renderers de módulo resolvem por locale (git/wh/parity/ap/dbt/pii)", () => {
  setHostLocale("pt-BR");
  assert.equal(hostT("git.st.modified"), "modificado");
  assert.equal(hostT("par.diffs", { count: 1, total: 9 }), "❌ **1 divergência** em 9 métricas:");
  assert.equal(hostT("ap.inListaGrande", { count: 51 }), "IN com ~51 itens literais — mova para uma tabela temporária/CTE e faça JOIN.");
  assert.equal(hostT("dbt.impact.downTransitive", { count: 1, depth: 2 }), "| Downstream transitivo | 1 modelo (profundidade 2) |");
  assert.equal(hostT("conf.media"), "média");
  setHostLocale("en");
  assert.equal(hostT("git.st.modified"), "modified");
  assert.equal(hostT("par.diffs", { count: 3, total: 9 }), "❌ **3 divergences** across 9 metrics:");
  assert.match(hostT("wh.err.toolMissing", { tool: "psql", hint: "x" }), /is not on PATH/);
  assert.equal(hostT("conf.media"), "medium");
  assert.equal(hostT("pii.cat.cartao"), "payment card");
  assert.match(hostT("wh.err.connNotExists", { id: "dw" }), /\/connections/); // texto en cita o label en
  setHostLocale("pt-BR");
});

test("guard: nenhum vscode.l10n.t remanescente (o mecanismo nativo não serve pt-BR-first)", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const url = await import("node:url");
  const repo = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..", "..");
  for (const rel of ["src/extension.ts", "src/core/Controller.ts"]) {
    const src = fs.readFileSync(path.join(repo, rel), "utf8");
    assert.ok(!/vscode\.l10n\.t\(/.test(src), `${rel} ainda usa vscode.l10n.t — use hostT (pt-BR-first)`);
  }
  // e o campo "l10n" do package.json foi removido (o vsce empacotaria bundles mortos)
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
  assert.equal(pkg.l10n, undefined, 'package.json não deve ter o campo "l10n" (mecanismo nativo abandonado)');
});
