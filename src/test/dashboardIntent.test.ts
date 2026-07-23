import assert from "node:assert/strict";
import { test } from "node:test";
import { isDashboardRequest } from "../util/dashboardIntent";

test("isDashboardRequest: ativa para criacao e alteracao de dashboards", () => {
  for (const value of [
    "crie um dashboard executivo de vendas usando @data/vendas.csv",
    "gere um painel de churn com os requisitos do arquivo anexado",
    "dashboard financeiro mensal",
    "painel operacional de rede",
    "build a React analytics dashboard from @sales.json",
    "melhore este dashboard em Streamlit",
    "crie uma tela de KPIs e indicadores com graficos",
  ]) {
    assert.equal(isDashboardRequest(value), true, `deveria detectar dashboard: ${value}`);
  }
});

test("isDashboardRequest: nao sequestra dados, dbt ou paineis fisicos", () => {
  for (const value of [
    "adicione uma exposure do dbt chamada dashboard_vendas",
    "explique qual query alimenta o dashboard de vendas",
    "crie uma tabela para o dashboard financeiro",
    "dimensione um painel solar residencial",
    "gere indicadores de qualidade para este dataframe",
    "corrija este pipeline ETL em Python",
    "onde fica o dashboard atual?",
    "",
  ]) {
    assert.equal(isDashboardRequest(value), false, `nao deveria detectar dashboard: ${value}`);
  }
});
