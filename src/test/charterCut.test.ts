import assert from "node:assert/strict";
import { test } from "node:test";
import { charterProbablyCut } from "../util/charterCut";

// O predicado é o REFORÇO para o "corte sem sinal" (HubGPU fecha "stop" no meio). Precisa pegar cortes
// FORTES sem NUNCA disparar num fim bem-formado — o falso positivo é o risco. Bateria dos dois lados.

test("charterProbablyCut: hífen de quebra silábica pendurado no fim → corte", () => {
  assert.equal(charterProbablyCut("garantindo a redução de custos-"), true);
  assert.equal(charterProbablyCut("- RNF-01: latência sub-"), true);
});

test("charterProbablyCut: termina em palavra de ligação minúscula de ≥2 letras → corte", () => {
  assert.equal(charterProbablyCut("Ele oferece visualizações intuitivas e alertas personalizados para"), true);
  assert.equal(charterProbablyCut("- RF-15: cobertura de 80% para toda a lógica de"), true);
  assert.equal(charterProbablyCut("armazena receitas e despesas em"), true);
  assert.equal(charterProbablyCut("O sistema deve validar todas as entradas com"), true);
  assert.equal(charterProbablyCut("armazenar em cofre de segredos ou"), true);
});

// REGRESSÃO (revisão adversarial): FALSOS POSITIVOS que a versão anterior (com toLowerCase + 1 letra +
// palavras inglesas) disparava indevidamente. Rótulos maiúsculos e valores de config são fim BEM-FORMADO.
test("charterProbablyCut: rótulo de UMA letra maiúscula (A/O) NÃO é corte", () => {
  assert.equal(charterProbablyCut("Nível de serviço: A"), false);
  assert.equal(charterProbablyCut("Vitamina A"), false);
  assert.equal(charterProbablyCut("Ver requisito RF-01 no anexo A"), false);
  assert.equal(charterProbablyCut("Fluxo principal descrito no diagrama A"), false);
  assert.equal(charterProbablyCut("Turno O"), false);
});

test("charterProbablyCut: valor de configuração em inglês (on/in/to) NÃO é corte", () => {
  assert.equal(charterProbablyCut("Modo standby: on"), false);
  assert.equal(charterProbablyCut("Feature flag: on"), false);
  assert.equal(charterProbablyCut("- RNF-02: telemetria opcional, padrão on"), false);
});

test("charterProbablyCut: siglas/unidades/números no fim NÃO são corte", () => {
  assert.equal(charterProbablyCut("- RNF-01: p95 < 200ms"), false);
  assert.equal(charterProbablyCut("- RNF-02: LGPD"), false);
  assert.equal(charterProbablyCut("- RNF-08: cobertura mínima de 80%"), false);
  assert.equal(charterProbablyCut("comunicação via TLS"), false); // sigla maiúscula
});

// FALSO POSITIVO é o perigo — listas de RF/RNF legítimas NÃO terminam em pontuação e NÃO podem disparar.
test("charterProbablyCut: bullets de RF/RNF bem-formados (sem ponto final) → NÃO é corte", () => {
  assert.equal(charterProbablyCut("- RF-01: o sistema deve autenticar via licença Ed25519"), false);
  assert.equal(charterProbablyCut("- RF-04: listar receitas e despesas paginadas"), false);
  assert.equal(charterProbablyCut("- RNF-02: LGPD — sem PII em logs"), false);
  // lista inteira, última linha é um item completo terminando em substantivo
  const lista = "- RF-01: cadastrar medicamentos\n- RF-02: listar medicamentos ativos\n- RF-03: remover medicamentos";
  assert.equal(charterProbablyCut(lista), false);
});

test("charterProbablyCut: prosa terminando em pontuação terminal → NÃO é corte", () => {
  assert.equal(charterProbablyCut("O aplicativo gerencia finanças pessoais de forma simples e segura."), false);
  assert.equal(charterProbablyCut("Ajuda o usuário a tomar decisões financeiras conscientes!"), false);
  assert.equal(charterProbablyCut("Cobre os seguintes casos:"), false); // dois-pontos fecha (introduz lista)
  assert.equal(charterProbablyCut("As metas (mensais)"), false); // fecha parêntese
});

test("charterProbablyCut: linha terminando em palavra de CONTEÚDO (substantivo/verbo) sem ponto → NÃO é corte", () => {
  // ambíguo, mas conservador: sem sinal FORTE, não dispara (evita falso positivo em item terso)
  assert.equal(charterProbablyCut("Gerenciar finanças pessoais"), false);
  assert.equal(charterProbablyCut("- Padronize mensagens de erro em português"), false);
});

test("charterProbablyCut: heading e linha numerada → NÃO é corte", () => {
  assert.equal(charterProbablyCut("## Requisitos funcionais"), false);
  assert.equal(charterProbablyCut("1. Autenticação"), false);
});

test("charterProbablyCut: vazio/espaços → NÃO é corte (tratado por outro caminho)", () => {
  assert.equal(charterProbablyCut(""), false);
  assert.equal(charterProbablyCut("   \n  \n"), false);
});

test("charterProbablyCut: ignora quebras/espaços finais ao achar a última linha real", () => {
  assert.equal(charterProbablyCut("registra receitas e despesas para\n\n  \n"), true); // corte na linha real
  assert.equal(charterProbablyCut("O sistema está pronto.\n\n"), false); // fim bem-formado + brancos
});

// A palavra de ligação só conta quando é a última PALAVRA colada ao fim — pontuação depois não casa.
test("charterProbablyCut: palavra de ligação seguida de pontuação NÃO dispara", () => {
  assert.equal(charterProbablyCut("depende do contexto e da entrada do usuário."), false);
  assert.equal(charterProbablyCut("Escolha entre A ou B."), false);
});
