import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { parseSkill } from "../skills/frontmatter";
import { DEFAULT_SELECTOR_CONFIG, lexicalScore, SkillSelector } from "../skills/SkillSelector";
import { SkillMeta } from "../skills/types";
import { findLayerViolations } from "../util/layerCheck";

const SKILLS_DIR = path.join(__dirname, "..", "..", "skills");

// Carrega a description REAL de uma skill empacotada (o que o SkillSelector pontua em produção).
function realSkill(dir: string): SkillMeta {
  const r = parseSkill(fs.readFileSync(path.join(SKILLS_DIR, dir, "SKILL.md"), "utf8"), dir);
  assert.ok(r.ok, `skill ${dir} deve parsear`);
  return { name: r.parsed!.frontmatter.name, description: r.parsed!.frontmatter.description, path: path.join(SKILLS_DIR, dir), source: "managed", enabled: true, validators: [], templates: [] };
}

const hex = realSkill("python-hexagonal-backend");

// Pedidos de backend Python — a skill DEVE ativar (score >= activationThreshold do config de produção).
test("python-hexagonal-backend ATIVA para pedidos de backend/API Python (description real)", () => {
  const queries = [
    "gere uma API REST em Python com arquitetura hexagonal",
    "crie um backend FastAPI com ports and adapters",
    "quero um microservice Python com domínio e casos de uso",
    "build a Python REST API service with clean architecture",
  ];
  for (const q of queries) {
    assert.ok(
      lexicalScore(q, hex) >= DEFAULT_SELECTOR_CONFIG.activationThreshold,
      `deveria ativar (score ${lexicalScore(q, hex).toFixed(2)} >= ${DEFAULT_SELECTOR_CONFIG.activationThreshold}): "${q}"`
    );
  }
});

// Concorrência real com as skills de DADOS: num pedido hexagonal, a hex ganha; num pedido de dados, perde
// (isolamento — não sequestra a geração de pandas/dbt, o público principal do FORGE).
test("python-hexagonal-backend ganha em pedido de backend e PERDE em pedido de dados (isolamento)", () => {
  const pandas = realSkill("pandas-defensive-pipelines");
  const dbt = realSkill("dbt-modeling");
  const backendQ = "crie uma API REST FastAPI com arquitetura hexagonal, ports e adapters";
  assert.ok(lexicalScore(backendQ, hex) > lexicalScore(backendQ, pandas), "hex > pandas no pedido de backend");
  assert.ok(lexicalScore(backendQ, hex) > lexicalScore(backendQ, dbt), "hex > dbt no pedido de backend");
  const dataQ = "limpe um dataframe pandas tratando nulos e dtypes";
  assert.ok(lexicalScore(dataQ, pandas) > lexicalScore(dataQ, hex), "pandas > hex no pedido de dados (isolamento)");

  const sel = new SkillSelector(DEFAULT_SELECTOR_CONFIG);
  const all = [hex, pandas, dbt];
  const activatedBackend = sel.selectForActivation(sel.selectForDiscovery(all, backendQ), backendQ);
  assert.equal(activatedBackend[0]?.name, "python-hexagonal-backend", "a skill hexagonal é a #1 ativada no pedido de backend");
});

// ALINHAMENTO skill↔gate (a razão de ser da skill): a estrutura que ela ENSINA passa na regra de camadas, e
// o anti-padrão que ela PROÍBE (domínio importando adapters) é exatamente o que o gate bloqueia. Sem este
// teste, uma mudança nos aliases do layerCheck poderia des-alinhar a skill do gate sem ninguém notar.
test("a estrutura que a skill ensina passa no findLayerViolations; o anti-padrão viola", () => {
  const good = [
    { path: "src/domain/models.py", content: "from dataclasses import dataclass\n@dataclass\nclass Order:\n    id: str\n" },
    { path: "src/domain/ports.py", content: "from typing import Protocol\nfrom domain.models import Order\nclass OrderRepository(Protocol):\n    def save(self, o: Order) -> None: ...\n" },
    { path: "src/application/create_order.py", content: "from domain.ports import OrderRepository\nclass CreateOrder:\n    def __init__(self, r: OrderRepository) -> None: self._r = r\n" },
    { path: "src/adapters/repository.py", content: "from domain.models import Order\nclass InMemoryRepo:\n    def save(self, o: Order) -> None: ...\n" },
  ];
  assert.equal(findLayerViolations(good, "hexagonal", "python").length, 0, "domínio puro + adapters→domínio = 0 violações");

  const bad = [...good, { path: "src/domain/leaky.py", content: "from adapters.repository import InMemoryRepo\n" }];
  const v = findLayerViolations(bad, "hexagonal", "python");
  assert.ok(v.some((x) => /domain\/leaky\.py$/.test(x.path)), "domínio importando adapters é bloqueado pelo gate");
});
