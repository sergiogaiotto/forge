import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { parseSkill } from "../skills/frontmatter";
import { DEFAULT_SELECTOR_CONFIG, lexicalScore, SkillSelector } from "../skills/SkillSelector";
import { SkillMeta } from "../skills/types";
import { findLayerViolations } from "../util/layerCheck";

const SKILLS_DIR = path.join(__dirname, "..", "..", "skills");
const T = DEFAULT_SELECTOR_CONFIG.activationThreshold;

function realSkill(dir: string): SkillMeta {
  const r = parseSkill(fs.readFileSync(path.join(SKILLS_DIR, dir, "SKILL.md"), "utf8"), dir);
  assert.ok(r.ok, `skill ${dir} deve parsear`);
  return { name: r.parsed!.frontmatter.name, description: r.parsed!.frontmatter.description, path: path.join(SKILLS_DIR, dir), source: "managed", enabled: true, validators: [], templates: [] };
}

// Todas as skills empacotadas (o catálogo REAL) — para a contenção por slot (maxActivations), não um trio sintético.
function allBundled(): SkillMeta[] {
  return fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => realSkill(d.name));
}

const hex = realSkill("hexagonal-backend");

test("hexagonal-backend ATIVA para pedidos de backend/API (EN e pt-BR)", () => {
  const queries = [
    "gere uma API REST em Python com arquitetura hexagonal",
    "crie um backend FastAPI com ports and adapters",
    "crie um serviço com portas e adaptadores e injeção de dependência", // pt-BR puro (antes: score 0)
    "monte um microsserviço com domínio e casos de uso",
    "build a Python microservice with clean architecture and use cases",
  ];
  for (const q of queries) {
    assert.ok(lexicalScore(q, hex) >= T, `deveria ativar (score ${lexicalScore(q, hex).toFixed(2)} >= ${T}): "${q}"`);
  }
});

// A ASSERÇÃO QUE FALTAVA (achado da revisão adversarial): a skill NÃO pode sequestrar pedidos de DADOS/scripts
// — o público principal do FORGE. Com o nome antigo (`python-...`) e a description repetindo tokens genéricos,
// TODOS estes ativavam (o token `python` valia raw 4). Estas asserções FALHARIAM com o design antigo.
test("hexagonal-backend NÃO ativa em pedidos de DADOS / script (isolamento — não sequestra o público principal)", () => {
  const negatives = [
    "ETL pipeline in Python",
    "escreva um script Python",
    "processe um arquivo CSV em Python",
    "limpe um dataframe pandas tratando nulos e dtypes",
    "build a data pipeline service in Python",
    "treine um modelo com pytorch",
  ];
  for (const q of negatives) {
    assert.ok(lexicalScore(q, hex) < T, `NÃO deveria ativar (score ${lexicalScore(q, hex).toFixed(2)} < ${T}): "${q}"`);
  }
});

test("no CATÁLOGO REAL: hexagonal-backend é a #1 num pedido de backend e AUSENTE num pedido de dados", () => {
  const all = allBundled();
  const sel = new SkillSelector(DEFAULT_SELECTOR_CONFIG);

  const backendQ = "crie uma API REST FastAPI com arquitetura hexagonal, ports e adapters";
  const actBackend = sel.selectForActivation(sel.selectForDiscovery(all, backendQ), backendQ);
  assert.equal(actBackend[0]?.name, "hexagonal-backend", "no pedido de backend, a skill hexagonal é a #1 ativada");

  // Num pedido de DADOS, a skill hexagonal NÃO pode aparecer entre as ativadas (maxActivations slots).
  const dataQ = "limpe e valide um dataframe pandas com nulos e depois grave em parquet";
  const actData = sel.selectForActivation(sel.selectForDiscovery(all, dataQ), dataQ);
  assert.ok(!actData.some((s) => s.name === "hexagonal-backend"), `a hexagonal NÃO deve ativar num pedido de dados (ativadas: ${actData.map((s) => s.name).join(", ")})`);
});

// ALINHAMENTO skill↔gate: a estrutura ACHATADA que a skill ensina passa na regra de camadas; o anti-padrão
// (domínio importa adapters) é o que o gate bloqueia. Sem este teste, uma mudança nos aliases do layerCheck
// des-alinharia a skill do gate silenciosamente.
test("a estrutura FLAT que a skill ensina passa no findLayerViolations; o anti-padrão viola", () => {
  const good = [
    { path: "domain/models.py", content: "from dataclasses import dataclass\n@dataclass\nclass Order:\n    id: str\n" },
    { path: "domain/ports.py", content: "from typing import Protocol\nfrom domain.models import Order\nclass OrderRepository(Protocol):\n    def save(self, o: Order) -> None: ...\n" },
    { path: "application/create_order.py", content: "from domain.ports import OrderRepository\nclass CreateOrder:\n    def __init__(self, r: OrderRepository) -> None: self._r = r\n" },
    { path: "adapters/repository.py", content: "from domain.models import Order\nfrom domain.ports import OrderRepository\nclass InMemoryRepo(OrderRepository):\n    def save(self, o: Order) -> None: ...\n" },
  ];
  assert.equal(findLayerViolations(good, "hexagonal", "python").length, 0, "domínio puro + adapters→domínio = 0 violações");

  const bad = [...good, { path: "domain/leaky.py", content: "from adapters.repository import InMemoryRepo\n" }];
  const v = findLayerViolations(bad, "hexagonal", "python");
  assert.ok(v.some((x) => /domain\/leaky\.py$/.test(x.path)), "domínio importando adapters é bloqueado pelo gate");
});
