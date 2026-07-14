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

// REGRESSÃO (revisão adversarial): DADOS que CITAM/EMITEM/PARSEIAM HTML sem nomear uma lib NÃO podem disparar
// (o "html"/"css" cru quebrava o isolamento). Relatório/e-mail/pytest/CSV/transform e scraping por INTENÇÃO
// (inclusive verbos pt-BR) → false. A palavra-técnica só conta com um substantivo de artefato-UI junto.
test("isFrontendRequest: dados-que-emitem/parseiam HTML sem lib nomeada → false (isolamento, achado da revisão)", () => {
  for (const t of [
    "gere um relatório em HTML das vendas do mês",
    "gere um relatório HTML de cobertura de testes",
    "crie um template de e-mail HTML para a newsletter",
    "escreva testes pytest para o parser de HTML",
    "converta este CSV em uma tabela HTML",
    "extraia os preços desta página HTML por regex",
    "raspe os links de uma página HTML",
    "parseie este HTML e extraia a tabela",
    "sanitize este CSS de entrada do usuário",
  ]) {
    assert.equal(isFrontendRequest(t), false, `NÃO deveria ser frontend (é dados/backend): ${t}`);
  }
});

// A palavra-técnica (html/css/js) só dispara COM um substantivo de artefato-UI — mantém o positivo legítimo.
test("isFrontendRequest: html/css/js cru só com artefato-UI (precisão sem perder o positivo)", () => {
  assert.equal(isFrontendRequest("monte um formulário de login em HTML/CSS/JavaScript"), true); // tem 'formulário'/'login'
  assert.equal(isFrontendRequest("gere a tela de cadastro em HTML"), true); // 'tela'/'cadastro'
  assert.equal(isFrontendRequest("preciso de HTML e CSS para isso"), false); // técnica sem artefato-UI → não dispara
});

// GAP de recall documentado: pedido MUITO curto de UI sem palavra-âncora não dispara (fraqueza conhecida da
// heurística; o pedido do App1 tinha âncora "html"+artefato/tailwind, então dispara — este caso registra o limite).
test("isFrontendRequest: pedido curto SEM âncora não dispara (gap de recall documentado)", () => {
  assert.equal(isFrontendRequest("faça um formulário de contato"), false);
  assert.equal(isFrontendRequest(""), false);
});

// FIX do survey pós-#217: o CAMPO 'email'/'newsletter' num formulário de UI legítimo NÃO pode mais ser
// suprimido pela porta negativa (o token cru `email`/`newsletter` em DATA_WEB matava login/cadastro/contato).
test("isFrontendRequest: form/UI de cliente com campo 'email'/'newsletter' → true (não é mais suprimido)", () => {
  for (const t of [
    "crie uma página HTML de login com campo de email e senha",
    "formulário de cadastro em HTML com nome e email, acessível (aria)",
    "landing page com formulário de inscrição na newsletter",
    "tela de contato em HTML com email e mensagem",
    "formulário de inscrição na newsletter em HTML", // form de newsletter (UI), não conteúdo de newsletter
    "formulário de newsletter em HTML acessível com aria",
    "formulário de contato acessível com email", // 'acessível' (adj) agora é sinal forte (acess[íi]\\w*)
    "modal de login com email em HTML", // 'modal'/'login' → contexto de form (override do gate de e-mail-dado)
    "página de cadastro com email e senha, acessível",
  ]) {
    assert.equal(isFrontendRequest(t), true, `UI com campo email/newsletter deveria ativar a11y: ${t}`);
  }
});

// Trava: e-mail/newsletter de DADOS (template/envio/marketing/HTML-do-email) segue false MESMO com um
// substantivo de UI junto ("botão") — o artefato é o e-mail, não a UI de browser (a11y não se aplica).
test("isFrontendRequest: e-mail/newsletter de DADOS (template/envio/marketing) segue false", () => {
  for (const t of [
    "crie um template de e-mail HTML de boas-vindas",
    "gere um e-mail em HTML com um botão de call-to-action", // o ARTEFATO é o e-mail (gere um e-mail)
    "email de confirmação em HTML com botão", // e-mail de propósito, mesmo com 'botão' (achado adversarial)
    "template do e-mail de recuperação de senha em HTML", // 'do' e-mail
    "e-mail transacional em HTML com um botão",
    "assinatura de e-mail em HTML",
    "preciso de um email em HTML com botão", // verbo fora da lista, mas 'email…html' sem contexto de form
    "um e-mail em HTML com um botão", // sem verbo, sem form → dado
    "email de marketing em HTML com botão",
    "boleto por email em HTML com botão", // artefato entregue POR e-mail (não é UI de browser)
    "escreva o código para enviar e-mail com nodemailer",
    "monte um template de newsletter em HTML",
    "gere o conteúdo de uma newsletter sobre o produto",
    "configure e-mail marketing com sendgrid",
  ]) {
    assert.equal(isFrontendRequest(t), false, `e-mail/newsletter de dados NÃO é frontend: ${t}`);
  }
});
