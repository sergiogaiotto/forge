// Dashboard e uma intencao de UI propria: pode ser web (React/HTML), mas tambem
// Streamlit/Dash. Mantenha esta deteccao separada de frontendIntent para nao fazer
// uma porta negativa de dados esconder pedidos legitimos de visualizacao.

const DASHBOARD_NOUN = /\b(dashboards?|pain[eé](?:l|is)|cockpits?|scorecards?)\b/i;
const ANALYTICS_UI = /\b(kpis?|indicadores?|analytics|business intelligence|visualiza[cç][aã]o de dados)\b/i;
const UI_CONTEXT = /\b(tela|interface|visual|gr[aá]fic\w*|chart\w*|react|html|tailwind|streamlit|plotly|dash\b|power\s*bi)\b/i;
const CHANGE_INTENT = /\b(crie|criar|gere|gerar|fa[cç]a|fazer|monte|montar|construa|construir|desenvolv\w*|implemente|implementar|prototip\w*|desenhe|redesign\w*|recrie|refatore|melhore|ajuste|altere|atualize|corrija|revise|transforme|converta|build|create|generate|make|design|implement|develop|prototype|refactor|improve|update|fix|review|turn|convert)\b/i;

// Referencias a artefatos de dados que apenas mencionam dashboard nao sao pedido de UI.
const DBT_EXPOSURE = /\b(dbt\b.{0,50}\bexposures?|exposures?\b.{0,50}\bdbt)\b/i;
const DATA_FEEDS_DASHBOARD = /\b(query|consulta|modelo|tabela|pipeline|etl)\b.{0,80}\b(alimenta|alimentar|feeds?|para|for)\b.{0,50}\bdashboards?\b/i;
const PHYSICAL_PANEL = /\bpain[eé](?:l|is)\s+(solar(?:es)?|el[eé]tric\w*|fotovoltaic\w*|de madeira|ac[uú]stic\w*)\b/i;
const INFORMATIONAL = /\b(explique|onde|qual|quais|liste|encontre|localize|documente|explain|where|what|which|list|find|document)\b/i;

export function isDashboardRequest(text: string): boolean {
  const value = (text ?? "").trim();
  if (!value) return false;
  if (PHYSICAL_PANEL.test(value)) return false;
  if (DBT_EXPOSURE.test(value) && !UI_CONTEXT.test(value)) return false;
  if (DATA_FEEDS_DASHBOARD.test(value) && !UI_CONTEXT.test(value)) return false;

  if (DASHBOARD_NOUN.test(value)) {
    if (CHANGE_INTENT.test(value) || UI_CONTEXT.test(value)) return true;
    // Aceitar briefs curtos como "dashboard executivo de vendas" ou "painel de churn".
    return !INFORMATIONAL.test(value) && value.split(/\s+/).length <= 8;
  }

  // KPI/indicadores so viram dashboard quando ha intencao de mudanca e contexto visual.
  return ANALYTICS_UI.test(value) && UI_CONTEXT.test(value) && CHANGE_INTENT.test(value);
}
