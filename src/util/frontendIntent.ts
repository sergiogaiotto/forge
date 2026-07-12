// Detecção de intenção FRONTEND (família F-10/F-14..F-21): o App1 (HTML/JS/Tailwind) vem pelo pipeline de
// CHAT, cujo prompt base (buildBasePrompt) é GLOBAL — enfiar regras de a11y/robustez de HTML ali poluiria a
// geração de Python/SQL/dados (o público principal do FORGE). Este heurístico PURO decide se um pedido é de
// gerar UI de CLIENTE (HTML/JS no browser) para o host ativar a skill frontend-html-a11y só nesse caso.
// Puro/sem dependências (testável isoladamente), espelhando classifyProjectIntent (projectIntent.ts).
//
// DUAS PORTAS, ordem deliberada:
//   1. porta NEGATIVA (vence): contexto de DADOS que CITA web (scraping/parsing HTML, data-viz que emite
//      HTML) — NÃO é geração de UI de cliente. Mata os falsos-positivos que preocupam o público de dados.
//   2. porta POSITIVA: exige um sinal de GERAÇÃO de UI de cliente (tag HTML literal, lib de UI, tecnologia
//      web por extenso, API de browser, a11y, extensão de arquivo web, ou frase "página web"/SPA).

// 1. DADOS-que-citam-web → NÃO é frontend de cliente. `to_html`/dataframe (pandas emitindo HTML), scraping
// (BeautifulSoup/Scrapy/Selenium/lxml/xpath), Streamlit (é Python server-side, não a UI-alvo). Vence tudo.
const DATA_WEB =
  /\b(pandas|dataframe|beautifulsoup|bs4|scrapy|selenium|playwright|lxml|xpath|streamlit|scrap\w*|crawler|to_html|read_html|requests\.get|urllib)\b/i;

// 2. Sinais POSITIVOS de geração de UI de cliente. `js`/`ui` crus são ambíguos demais (fora); formas longas.
const FRONTEND_SIGNAL = new RegExp(
  [
    String.raw`<(script|div|button|input|form|html|body|ul|li|span|label|select|textarea)\b`, // tag HTML literal no pedido
    String.raw`\b(tailwind|bootstrap|react|vue|svelte|angular|jquery|htmx|alpine\.?js)\b`, // libs de UI
    String.raw`\b(html|css|javascript|frontend|front-end|dom|web ?component)\b`, // tecnologia web por extenso
    String.raw`\b(localstorage|sessionstorage|queryselector\w*|addeventlistener|getelementby\w+|createelement|innerhtml)\b`, // API de browser
    String.raw`\b(aria|aria-\w+|acessib\w*|accessib\w*|wcag)\b|leitor de tela|screen reader`, // acessibilidade
    String.raw`\.(html|htm|jsx|tsx|vue|css|scss)\b`, // extensão de arquivo web
    String.raw`\bp[áa]gina web\b|\bsingle[\s-]?page\b|\bspa\b|\bweb ?app\b|aplica[çc][ãa]o web|interface web|landing page`, // frase
  ].join("|"),
  "i"
);

// Verdadeiro só quando NÃO é contexto de dados-que-cita-web E há sinal de geração de UI de cliente.
export function isFrontendRequest(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  if (DATA_WEB.test(t)) return false; // porta negativa vence
  return FRONTEND_SIGNAL.test(t);
}
