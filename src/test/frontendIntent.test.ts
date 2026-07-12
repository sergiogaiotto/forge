import assert from "node:assert/strict";
import { test } from "node:test";
import { isFrontendRequest } from "../util/frontendIntent";

// POSITIVOS — geração de UI de cliente (a skill frontend-html-a11y deve ser forçada).
test("isFrontendRequest: pedidos de UI de cliente → true", () => {
  for (const t of [
    "crie um todo app em HTML com Tailwind",
    "faça uma página web de notas que salva no localStorage",
    "monte um formulário de login em HTML/CSS/JavaScript",
    "gere um componente React com um contador",
    "preciso de uma interface web acessível (aria) para cadastro",
    "crie um app single-page em vue",
    "faça um botão que usa addEventListener e querySelector",
    "gere um index.html com um formulário",
  ]) {
    assert.equal(isFrontendRequest(t), true, `deveria ser frontend: ${t}`);
  }
});

// NEGATIVOS (porta negativa) — DADOS que citam web NÃO são frontend de cliente.
test("isFrontendRequest: dados-que-citam-web → false (porta negativa vence)", () => {
  for (const t of [
    "faça scraping de uma página HTML com BeautifulSoup",
    "crie um dashboard em Streamlit",
    "parseie o DOM com lxml e xpath",
    "gere um relatório HTML do dataframe com df.to_html",
    "leia a tabela da página com pandas.read_html",
    "extraia links com Scrapy e Selenium",
  ]) {
    assert.equal(isFrontendRequest(t), false, `NÃO deveria ser frontend (é dados): ${t}`);
  }
});

// NEGATIVOS — geração de dados/backend pura NÃO dispara (sem poluir Python/SQL).
test("isFrontendRequest: geração de dados/backend pura → false", () => {
  for (const t of [
    "limpe esse dataframe com pandas e trate os nulos",
    "escreva uma query SQL que agrega vendas por mês",
    "crie um pipeline Spark de ETL",
    "implemente um endpoint FastAPI que retorna JSON",
    "gere testes pytest para o módulo de faturamento",
  ]) {
    assert.equal(isFrontendRequest(t), false, `NÃO deveria ser frontend: ${t}`);
  }
});

// GAP de recall documentado: pedido MUITO curto de UI sem palavra-âncora não dispara (fraqueza conhecida da
// heurística; o pedido do App1 tinha âncora "html", então dispara — este caso registra o limite).
test("isFrontendRequest: pedido curto SEM âncora não dispara (gap de recall documentado)", () => {
  assert.equal(isFrontendRequest("faça um formulário de contato"), false);
  assert.equal(isFrontendRequest(""), false);
});
