// Detecção de intenção FRONTEND (família F-10/F-14..F-21): o App1 (HTML/JS/Tailwind) vem pelo pipeline de
// CHAT, cujo prompt base (buildBasePrompt) é GLOBAL — enfiar regras de a11y/robustez de HTML ali poluiria a
// geração de Python/SQL/dados (o público principal do FORGE). Este heurístico PURO decide se um pedido é de
// gerar UI de CLIENTE (HTML/JS no browser) para o host ativar a skill frontend-html-a11y só nesse caso.
// Puro/sem dependências (testável isoladamente), espelhando classifyProjectIntent (projectIntent.ts).
//
// ISOLAMENTO É O CRITÉRIO #1 (achado da revisão adversarial): "html"/"css"/"javascript" CRUS aparecem em
// muitíssimo contexto de DADOS (relatório em HTML, e-mail HTML, `df.to_html`, parser de HTML, scraping) — não
// podem, sozinhos, marcar frontend. Três camadas, ordem deliberada:
//   1. porta NEGATIVA (vence): DADOS que citam/emitem/parseiam web (libs de scraping/pandas, relatório/e-mail/
//      teste, scraping por INTENÇÃO em pt-BR). Rejeita ANTES de olhar sinais positivos.
//   2. sinal FORTE (standalone): tag HTML literal, lib de UI, API de browser, a11y, extensão web, frase de UI,
//      "frontend" — cada um já é específico de geração de UI de cliente.
//   3. palavra-TÉCNICA fraca (html/css/javascript/dom): só conta se co-ocorrer com um SUBSTANTIVO de
//      artefato-UI (formulário/botão/tela/app/interface/login…) — senão é menção incidental de dados.

// 1. DADOS-que-citam-web → NÃO é frontend de cliente. Vence tudo. Além das libs (pandas/scraping/Streamlit),
// inclui contexto de RELATÓRIO/E-MAIL/TESTE/transformação e VERBOS de scraping/parsing (pt-BR e en), que são
// justamente os falsos-positivos do "html" cru (a porta positiva os deixava passar — achado da revisão).
const DATA_WEB =
  /\b(pandas|dataframe|beautifulsoup|bs4|scrapy|selenium|playwright|lxml|xpath|streamlit|scrap\w*|crawler|to_html|read_html|to_csv|requests\.get|urllib|relat[óo]rio|report|pytest|unittest|\bcsv\b|parser|parsear|parseie|sanitiz\w*|raspe\w*|raspar|raspagem)\b/i;

// E-mail/newsletter só são DADOS (template/envio/marketing/HTML) — NÃO o CAMPO `email` de um formulário de
// login/cadastro/contato nem a landing page de inscrição numa newsletter. O token CRU (`email`/`newsletter`
// em DATA_WEB) suprimia a skill de a11y numa classe enorme de UI legítima (achado do survey pós-#217, a porta
// negativa vence ANTES do sinal forte). Exige o contexto de template/envio/marketing/HTML — assim "template
// de e-mail HTML com botão" (que teria UI_NOUN e ativaria a11y à toa) é rejeitado, mas "form de login com
// email" ativa. Puro.
const EMAIL_NEWSLETTER_DATA = new RegExp(
  [
    String.raw`\b(e-?mail|newsletter)\b.{0,20}\bhtml\b`, // e-mail/newsletter … HTML (o artefato É um e-mail em HTML)
    String.raw`\bhtml\b.{0,12}\b(e-?mail|newsletter)\b`, // HTML … e-mail/newsletter (en/pt, outra ordem)
    // O ARTEFATO é o próprio e-mail/newsletter: "gere/crie UM e-mail", "escreva UMA newsletter".
    String.raw`\b(gere|crie|fa[çc]a|monte|escreva|redija|construa|desenvolva|prepare|elabore) (um |uma |o |a )?(e-?mail|newsletter)\b`,
    String.raw`\b(template|modelo) d[eo] (e-?mail|newsletter)\b`, // template/modelo de/do e-mail|newsletter
    String.raw`\be-?mail[\s-]?marketing\b|\bmarketing (de|por) e-?mail\b|\be-?mail de marketing\b`, // e-mail marketing
    // E-mail de PROPÓSITO/tipo (transacional): o artefato é um e-mail, não uma UI de browser.
    String.raw`\be-?mail (transacional|responsiv\w+|de (confirma|recupera|redefini|verifica|ativa|boas|reset|welcome|notifica)\w*)`,
    String.raw`\bassinatura de e-?mail\b`, // assinatura (signature) de e-mail
    String.raw`\b(enviar|disparar|mandar|envie|envio de|send\w*) (um |uma |the )?(e-?mails?|newsletter)\b`, // envio (backend)
    String.raw`\b(smtp|sendgrid|mailgun|nodemailer)\b`, // libs de envio de e-mail
    String.raw`\b(conte[úu]do|texto)\b.{0,20}\bnewsletter\b`, // conteúdo/texto DA newsletter
  ].join("|"),
  "i"
);

// Contexto de FORM/PÁGINA que TORNA o e-mail/newsletter um CAMPO/assunto de UI (não o artefato-dado): um
// substantivo de FORMULÁRIO/PÁGINA precede o `email` (login/cadastro/inscrição/tela/página…). É o distintivo
// entre "form de cadastro em HTML com email" (UI → ativa a11y) e "email de confirmação em HTML com botão"
// (dado → suprime): `botão`/`menu` NÃO entram (aparecem em e-mail HTML); só estrutura de form/página. Puro.
const UI_FORM_CONTEXT =
  /\b(formul[áa]rio|form|campo|login|cadastr\w*|inscri[çc]\w*|sign[\s-]?up|landing page|navbar|sidebar|modal|widget|componente|tela|p[áa]gina|interface)\b/i;

// 2. Sinais FORTES (standalone) de geração de UI de cliente.
const STRONG_UI = new RegExp(
  [
    String.raw`<(script|div|button|input|form|html|body|ul|li|span|label|select|textarea)\b`, // tag HTML literal
    String.raw`\b(tailwind|bootstrap|react|vue|svelte|angular|jquery|htmx|alpine\.?js)\b`, // libs de UI
    String.raw`\b(frontend|front-end)\b`, // "frontend" cru já é UI de cliente
    String.raw`\b(localstorage|sessionstorage|queryselector\w*|addeventlistener|getelementby\w+|createelement|innerhtml)\b`, // API de browser
    String.raw`\b(aria|aria-\w+|acess[íi]\w*|accessib\w*|wcag)\b|leitor de tela|screen reader`, // acessibilidade (acess[íi]\w* casa acessível E acessibilidade)
    String.raw`\.(html|htm|jsx|tsx|vue|css|scss)\b`, // extensão de arquivo web
    String.raw`\bp[áa]gina web\b|\bsingle[\s-]?page\b|\bspa\b|\bweb ?app\b|aplica[çc][ãa]o web|interface web|landing page`, // frase
  ].join("|"),
  "i"
);

// 3. Palavra-técnica FRACA — só conta com um substantivo de artefato-UI junto.
const TECH_WORD = /\b(html|css|javascript|dom|web ?component)\b/i;
const UI_NOUN =
  /\b(site|app|aplica[çc][ãa]o|interface|tela|formul[áa]rio|bot[ãa]o|menu|modal|login|cadastro|componente|widget|layout|navbar|sidebar|carrossel|carousel)\b/i;

// Verdadeiro só quando NÃO é contexto de dados-que-cita-web E há sinal FORTE de UI de cliente, OU uma
// palavra-técnica de web co-ocorrendo com um substantivo de artefato-UI.
export function isFrontendRequest(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  if (DATA_WEB.test(t)) return false; // dados-que-citam-web (pandas/scraping/relatório…) — vence sempre
  // e-mail/newsletter é DADO (template/em-HTML/envio/marketing) — EXCETO num contexto de FORM/página, onde é
  // um CAMPO de UI (o token cru suprimia login/cadastro/contato — achado do survey pós-#217).
  if (EMAIL_NEWSLETTER_DATA.test(t) && !UI_FORM_CONTEXT.test(t)) return false;
  if (STRONG_UI.test(t)) return true; // sinal forte, standalone
  return TECH_WORD.test(t) && UI_NOUN.test(t); // técnica fraca só com artefato-UI
}
