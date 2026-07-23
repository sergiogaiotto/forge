import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { AttachmentStore } from "../core/AttachmentStore";
import { ContextAssembler } from "../skills/ContextAssembler";
import { parseSkill } from "../skills/frontmatter";
import { DEFAULT_SELECTOR_CONFIG, lexicalScore, SkillSelector } from "../skills/SkillSelector";
import { SkillMeta } from "../skills/types";

const SKILL_DIR = path.join(__dirname, "..", "..", "skills", "claro-dashboard-ui");
const SKILL_FILE = path.join(SKILL_DIR, "SKILL.md");

function loadSkill(): { meta: SkillMeta; body: string } {
  const parsed = parseSkill(fs.readFileSync(SKILL_FILE, "utf8"), "claro-dashboard-ui");
  assert.ok(parsed.ok && parsed.parsed, `skill deve parsear: ${parsed.errors.map((e) => e.message).join(", ")}`);
  return {
    meta: {
      name: parsed.parsed.frontmatter.name,
      description: parsed.parsed.frontmatter.description,
      path: SKILL_DIR,
      source: "managed",
      enabled: true,
      validators: [],
      templates: [],
    },
    body: parsed.parsed.body,
  };
}

test("claro-dashboard-ui: frontmatter valido, referencia preservada e regras essenciais presentes", () => {
  const { meta, body } = loadSkill();
  assert.ok(fs.existsSync(path.join(SKILL_DIR, "references", "claro-ui-reference.png")));
  assert.ok(fs.existsSync(path.join(SKILL_DIR, "references", "claro-dashboard-quality-bar.png")));
  assert.match(meta.description, /Excel (?:or|ou) XLSX/);
  assert.match(body, /--claro-red: #da291c/);
  assert.match(body, /Tratar a mensagem do usuario como intencao/);
  assert.match(body, /Nunca redesenhar,/);
  assert.match(body, /carregando, vazio, erro, parcial e sucesso/);
  assert.match(body, /Nao encerrar com uma pagina de titulo, schema/);
  assert.match(body, /pelo menos tres familias analiticas relevantes/);
  assert.match(body, /Variar o layout\s+por completo/);
  assert.ok(body.split(/\r?\n/).length < 500, "o corpo principal deve permanecer enxuto");
});

test("claro-dashboard-ui: playbooks cobrem dados, charts, variacao, design e stacks", () => {
  const refs = {
    data: fs.readFileSync(path.join(SKILL_DIR, "references", "data-integrity.md"), "utf8"),
    charts: fs.readFileSync(path.join(SKILL_DIR, "references", "visualization-playbook.md"), "utf8"),
    layouts: fs.readFileSync(path.join(SKILL_DIR, "references", "dashboard-archetypes.md"), "utf8"),
    design: fs.readFileSync(path.join(SKILL_DIR, "references", "design-system.md"), "utf8"),
    stacks: fs.readFileSync(path.join(SKILL_DIR, "references", "framework-guides.md"), "utf8"),
  };

  assert.match(refs.data, /Nao renderizar esse inventario como dashboard final/);
  assert.match(refs.data, /media de medias sem pesos/);
  assert.match(refs.charts, /### Gauge/);
  assert.match(refs.charts, /### Pizza e donut/);
  assert.match(refs.charts, /### Box plot/);
  assert.match(refs.charts, /dashboard que e apenas uma tabela/);
  for (const archetype of ["Executivo", "Operacional", "Analitico", "Preditivo", "Jornada e funil", "Geografico e rede"]) {
    assert.match(refs.layouts, new RegExp(`## \\d+\\. ${archetype}`));
  }
  assert.match(refs.design, /--claro-red-500: #da291c/);
  assert.match(refs.stacks, /Nao gerar uma pagina estatica contendo apenas `df\.head\(\)\.to_html\(\)`/);
});

test("claro-dashboard-ui: seletor lexical ativa no pedido explicito", () => {
  const { meta } = loadSkill();
  for (const query of [
    "gere um dashboard executivo de vendas com React",
    "transforme dados_analise_preditiva.xlsx em um painel analitico",
    "crie um cockpit operacional em Streamlit com gauges e box plots",
  ]) {
    assert.ok(lexicalScore(query, meta) >= DEFAULT_SELECTOR_CONFIG.activationThreshold, query);
    const selected = new SkillSelector(DEFAULT_SELECTOR_CONFIG).selectForActivation([meta], query);
    assert.equal(selected[0]?.name, "claro-dashboard-ui");
  }
});

test("dashboard + upload ou @: skill e conteudo anexado chegam juntos ao prompt", () => {
  const { meta, body } = loadSkill();
  for (const input of [
    { kind: "upload" as const, label: "vendas.csv", query: "Crie um dashboard executivo usando o arquivo anexado" },
    { kind: "workspace" as const, label: "data/vendas.csv", query: "Crie um dashboard executivo usando @data/vendas.csv" },
    { kind: "upload" as const, label: "dados_analise_preditiva.xlsx", query: "Crie um painel preditivo usando o Excel anexado" },
  ]) {
    const attachments = new AttachmentStore(() => undefined);
    attachments.add(input.label, input.kind, "mes,receita,meta\n2026-01,120000,110000");

    const assembled = new ContextAssembler().assemble({
      basePrompt: "BASE",
      discoverySkills: [meta],
      activatedSkills: [{ meta, body }],
      retrievedContext: attachments.consumeAsContext(),
      history: [],
      query: input.query,
      inputBudgetTokens: 12000,
    });

    assert.match(assembled.systemPrompt, /# Skill ativada: claro-dashboard-ui/);
    assert.ok(assembled.systemPrompt.includes(`### Anexo: ${input.label}`));
    assert.match(assembled.systemPrompt, /mes,receita,meta/);
    assert.equal(assembled.messages.at(-1)?.content, input.query);
    assert.equal(attachments.count(), 0, "o anexo e consumido no envio");
  }
});
