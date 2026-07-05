import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildAcceptanceTestsRequest,
  buildBasePrompt,
  buildBlueprintRetryRequest,
  buildBlueprintSystemPrompt,
  buildCharterContinuationPrompt,
  buildCharterSystemPrompt,
  buildContinuationPrompt,
  buildProjectFromBlueprintPrompt,
  buildProjectPrompt,
  buildProjectRepairPrompt,
  buildReviewPrompt,
  buildTailContinuation,
  buildTddPrompt,
  frameworkInstruction,
  uiLayerInstruction,
} from "../core/systemPrompt";

// Onda 2 — o prompt de auto-reparo mostra o arquivo reprovado, os erros do mypy e o CONTRATO REAL dos
// deps que passaram, exigindo blocos forge-file completos e proibindo símbolos inventados.
test("buildProjectRepairPrompt: injeta erros, contrato real e o protocolo forge-file", () => {
  const p = buildProjectRepairPrompt("ws", "python", "hexagonal", [
    {
      path: "src/app/create_order.py",
      content: "from src.domain.entities import OrderStatus",
      errors: ['linha 1: Module "src.domain.entities" has no attribute "OrderStatus"'],
      contracts: [{ path: "src/domain/entities.py", content: "class Order:\n    id: OrderId" }],
    },
  ]);
  assert.match(p, /AUTO-REPARO/);
  assert.match(p, /src\/app\/create_order\.py/);
  assert.match(p, /has no attribute "OrderStatus"/); // o erro do mypy entra no prompt
  assert.match(p, /CONTRATO REAL de src\/domain\/entities\.py/); // o contrato real é injetado
  assert.match(p, /class Order/);
  assert.match(p, /forge-file/); // exige o protocolo de blocos aplicáveis
  assert.match(p, /PROIBIDO|Use SOMENTE/); // regra anti-símbolo-fantasma
});

// Camada de UI OPCIONAL do Modo Projeto (seletor no composer): "auto" não injeta nada (comportamento
// clássico); as demais viram instrução explícita no blueprint E na geração, por linguagem.
test("uiLayerInstruction: auto/undefined vazio; none/template/spa/streamlit por linguagem", () => {
  assert.equal(uiLayerInstruction("python", undefined), "");
  assert.equal(uiLayerInstruction("python", "auto"), "");
  assert.match(uiLayerInstruction("python", "none"), /NÃO inclua interface/);
  assert.match(uiLayerInstruction("python", "template-engine"), /Jinja2/);
  assert.match(uiLayerInstruction("typescript", "template-engine"), /EJS/);
  assert.match(uiLayerInstruction("java", "template-engine"), /Thymeleaf/);
  assert.match(uiLayerInstruction("go", "template-engine"), /html\/template/);
  assert.match(uiLayerInstruction("python", "spa-react"), /React/);
  assert.match(uiLayerInstruction("python", "streamlit"), /Streamlit/);
  // Streamlit é Python-only: outra linguagem cai no vazio (defensivo — a webview já filtra).
  assert.equal(uiLayerInstruction("typescript", "streamlit"), "");
});

// Framework web do projeto Python (FastAPI/Flask/Litestar): "auto" não injeta nada; Python-only.
test("frameworkInstruction: auto vazio; FastAPI/Flask/Litestar explícitos; Python-only", () => {
  assert.equal(frameworkInstruction("python", undefined), "");
  assert.equal(frameworkInstruction("python", "auto"), "");
  assert.match(frameworkInstruction("python", "fastapi"), /FastAPI/);
  assert.match(frameworkInstruction("python", "flask"), /Flask/);
  assert.match(frameworkInstruction("python", "litestar"), /Litestar/);
  // defensivo: framework Python não vaza para outra linguagem
  assert.equal(frameworkInstruction("typescript", "fastapi"), "");
});

test("prompts do projeto propagam o framework (e convivem com a camada de UI)", () => {
  assert.match(buildBlueprintSystemPrompt("python", "hexagonal", "auto", "fastapi"), /FastAPI/);
  assert.ok(!buildBlueprintSystemPrompt("python", "hexagonal").includes("FRAMEWORK WEB")); // auto = como antes
  // framework + template engine juntos: as duas instruções presentes e compatíveis (Jinja2 em cima do framework)
  const both = buildBlueprintSystemPrompt("python", "hexagonal", "template-engine", "litestar");
  assert.match(both, /Litestar/);
  assert.match(both, /Jinja2/);
  const guided = buildProjectFromBlueprintPrompt("proj", "python", "hexagonal", [{ path: "a.py", purpose: "p", deps: [] }], "auto", "flask");
  assert.match(guided, /Flask/);
  assert.match(buildProjectPrompt("proj", "python", "hexagonal", "auto", "fastapi"), /FastAPI/);
});

test("prompts do projeto propagam a camada de UI escolhida (blueprint, guiado e direto)", () => {
  assert.match(buildBlueprintSystemPrompt("python", "hexagonal", "template-engine"), /Jinja2/);
  assert.ok(!buildBlueprintSystemPrompt("python", "hexagonal").includes("CAMADA DE UI")); // auto = como antes
  const guided = buildProjectFromBlueprintPrompt("proj", "python", "hexagonal", [{ path: "a.py", purpose: "p", deps: [] }], "none");
  assert.match(guided, /NÃO inclua interface/);
  assert.match(buildProjectPrompt("proj", "python", "hexagonal", "streamlit"), /Streamlit/);
  assert.ok(!buildProjectPrompt("proj", "python", "hexagonal").includes("CAMADA DE UI"));
});

// 2ª tentativa do blueprint: com resposta anterior → CONVERSÃO da própria resposta no array exato;
// sem resposta (veio vazia) → repete o pedido com o formato reforçado. Sempre exige '[' … ']'.
test("buildBlueprintRetryRequest: com resposta anterior pede a CONVERSÃO e inclui o texto capado", () => {
  const p = buildBlueprintRetryRequest("crie uma app de senhas", "Aqui está meu plano em prosa: main.py, util.py…");
  assert.match(p, /CONVERTA/);
  assert.match(p, /\{"files":\[/); // aceita o objeto do modo json_object
  assert.ok(p.includes("crie uma app de senhas"));
  assert.ok(p.includes("main.py, util.py"));
  // resposta anterior gigante é capada (teto de 4000) para não estourar a janela
  const big = buildBlueprintRetryRequest("brief", "x".repeat(20_000));
  assert.ok(big.length < 6000);
});

// REGRESSÃO (blueprint FinOps em campo): o cap mantinha o COMEÇO e descartava o array no FIM da
// resposta anterior — a conversão recebia só prosa e falhava. Cap BIPARTIDO preserva as duas pontas.
test("buildBlueprintRetryRequest: o cap bipartido preserva a CAUDA (array no fim) E o COMEÇO", () => {
  const array = '[{"path":"src/main.py","purpose":"entry"},{"path":"README.md","purpose":"docs"}]';
  const tail = "raciocínio longo… ".repeat(400) + array; // array só nos últimos chars
  const reqTail = buildBlueprintRetryRequest("crie um app", tail);
  assert.ok(reqTail.includes(array), "o array do fim tem que sobreviver ao cap");
  // plano MAIOR que o cap com degeneração DEPOIS: o início (com o '[' e primeiros objetos) sobrevive
  const head = array + " eco eco ".repeat(600);
  const reqHead = buildBlueprintRetryRequest("crie um app", head);
  assert.ok(reqHead.includes('[{"path":"src/main.py"'), "o começo tem que sobreviver ao cap");
  assert.ok(reqHead.includes("trecho intermediário omitido"));
  // curto passa intacto, sem marcador de omissão
  assert.ok(!buildBlueprintRetryRequest("b", "resposta curta").includes("omitido"));
});

test("buildBlueprintRetryRequest: sem resposta anterior reforça o formato no pedido original", () => {
  const p = buildBlueprintRetryRequest("crie uma app de senhas", "   ");
  assert.match(p, /2ª tentativa/);
  assert.match(p, /APENAS com o JSON do plano/);
  assert.ok(p.includes("crie uma app de senhas"));
  assert.ok(!p.includes("CONVERTA"));
});

test("prompt TDD inclui o prompt base e instruções de test-first", () => {
  const p = buildTddPrompt("meu-projeto");
  assert.ok(p.includes("FORGE"));
  assert.ok(p.includes("meu-projeto"));
  assert.match(p, /MODO TDD/);
  assert.match(p, /pytest/);
  assert.match(p, /test_/);
  // mantém o protocolo de edição de arquivos do prompt base
  assert.ok(p.includes("forge-file"));
});

test("prompt de revisão é multi-lente e em pt-BR", () => {
  const p = buildReviewPrompt();
  assert.match(p, /FORGE Review/);
  assert.match(p, /Segurança/);
  assert.match(p, /LGPD/);
  assert.match(p, /severidade/);
  assert.match(p, /pt-BR/);
});

test("prompt base exige pt-BR", () => {
  assert.match(buildBasePrompt("x"), /pt-BR/);
});

test("prompt base proíbe elipses/omissões para forçar o arquivo completo", () => {
  const p = buildBasePrompt("x");
  assert.match(p, /PROIBIDO/);
  assert.match(p, /restante do código/); // veta o placeholder exato observado no print
  assert.match(p, /linha por linha/);
});

test("prompt de revisão também proíbe omissões no bloco corrigido", () => {
  const p = buildReviewPrompt();
  // mesma regra compartilhada (NO_ELLIPSIS_RULE) que o prompt base
  assert.match(p, /PROIBIDO/);
  assert.match(p, /restante do código/);
});

test("buildContinuationPrompt cita o arquivo, manda continuar e proíbe reabrir a cerca", () => {
  const p = buildContinuationPrompt("src/a.py");
  assert.match(p, /src\/a\.py/);
  assert.match(p, /CONTINUE/);
  assert.match(p, /NÃO reabra/i);
  assert.match(p, /PROIBIDO|reticências/i); // herda o NO_ELLIPSIS_RULE
});

test("buildProjectPrompt (Python/hexagonal): linguagem, camadas, protocolo forge-file, manifesto e anti-elipse", () => {
  const p = buildProjectPrompt("proj", "python", "hexagonal");
  assert.match(p, /Python/);
  assert.match(p, /hexagonal/i);
  assert.match(p, /forge-file/);
  assert.match(p, /domain/);
  assert.match(p, /ports/);
  assert.match(p, /Protocol|ABC/); // mecanismo de interface do Python
  assert.match(p, /pyproject|requirements/i); // manifesto
  assert.match(p, /TESTES/); // pede testes por camada
  assert.match(p, /PROIBIDO|reticências/i); // NO_ELLIPSIS_RULE
});

test("buildProjectPrompt EXIGE README.md com propósito, funcionalidades e comandos de execução", () => {
  const p = buildProjectPrompt("proj", "python", "hexagonal");
  assert.match(p, /README\.md/);
  assert.match(p, /PROP[ÓO]SITO/i);
  assert.match(p, /FUNCIONALIDADES/i);
  assert.match(p, /Como rodar/i);
  assert.match(p, /venv/i); // comandos de ambiente para Python
  assert.match(p, /pytest/); // rodar os testes
  // por linguagem: TypeScript documenta npm em vez de venv
  const ts = buildProjectPrompt("p", "typescript", "mvc");
  assert.match(ts, /README\.md/);
  assert.match(ts, /npm (install|run)/);
});

test("buildAcceptanceTestsRequest: pede testes de aceitação test-first e embute só os requisitos presentes", () => {
  const p = buildAcceptanceTestsRequest("- RF-01: autenticar via licença", "- RNF-01: p95 < 200ms");
  assert.match(p, /TESTES DE ACEITA[ÇC][ÃA]O/i);
  assert.match(p, /test-first|NÃO implemente o código/i);
  assert.match(p, /## Requisitos funcionais/);
  assert.match(p, /RF-01: autenticar/);
  assert.match(p, /## Requisitos não funcionais/);
  assert.match(p, /RNF-01/);
  // só NFR: não injeta a seção de FR vazia
  const onlyNfr = buildAcceptanceTestsRequest("", "- RNF-02: LGPD");
  assert.ok(!onlyNfr.includes("## Requisitos funcionais"));
  assert.match(onlyNfr, /## Requisitos não funcionais/);
});

test("buildCharterSystemPrompt: cada seção pede o conteúdo certo, em pt-BR e SÓ o markdown", () => {
  const purpose = buildCharterSystemPrompt("purpose");
  assert.match(purpose, /PROP[ÓO]SITO/i);
  assert.match(purpose, /pt-BR/);
  assert.match(purpose, /APENAS|NADA de título/i); // regra de saída limpa
  const fr = buildCharterSystemPrompt("fr");
  assert.match(fr, /REQUISITOS FUNCIONAIS/i);
  assert.match(fr, /RF-01|bullets/i);
  const nfr = buildCharterSystemPrompt("nfr");
  assert.match(nfr, /N[ÃA]O FUNCIONAIS/i);
  assert.match(nfr, /LGPD|seguran/i);
  const rules = buildCharterSystemPrompt("rules");
  assert.match(rules, /REGRAS/i);
  assert.match(rules, /sempre|nunca|prefira/i);
});

// Regras/RF/RNF com rascunho vazio: o escopo vem do PROPÓSITO já preenchido — sem a âncora, o modelo
// redige requisitos genéricos de "um sistema qualquer". O Propósito em si não tem a âncora (é a fonte).
test("buildCharterSystemPrompt: seções ancoram no Propósito quando o rascunho está vazio", () => {
  for (const key of ["rules", "fr", "nfr"] as const) {
    assert.match(buildCharterSystemPrompt(key), /VAZIO: derive a seção do PROPÓSITO/i);
  }
  assert.ok(!buildCharterSystemPrompt("purpose").includes("derive a seção do PROPÓSITO"));
});

test("buildCharterContinuationPrompt: retoma no ponto exato, sem repetir nem comentar", () => {
  const p = buildCharterContinuationPrompt("Propósito");
  assert.match(p, /CORTADA por limite de tokens/);
  assert.match(p, /"Propósito"/);
  assert.match(p, /NÃO repita/);
  assert.match(p, /pr[óo]ximo caractere/i);
});

test("buildTailContinuation: manda emitir o restante dos arquivos, sem repetir nem reabrir bloco", () => {
  const p = buildTailContinuation();
  assert.match(p, /CONTINUE/);
  assert.match(p, /restante|próximos arquivos/i);
  assert.match(p, /NÃO reabra/i);
});

// Onda 1 (quick wins 1.3/1.4): o prompt do projeto injeta o PROPÓSITO do charter e as deps FIXADAS do
// requirements.txt — sem isso o modelo ignora o charter (sai o exemplo Pedido/Pagamento) e alucina libs.
test("buildBlueprintSystemPrompt: injeta propósito do charter e deps fixadas quando há contexto", () => {
  const ctx = { purpose: "Agente de IA para P&D de materiais", pinnedDeps: ["fastapi==0.110.0", "pydantic==2.6.0"] };
  const p = buildBlueprintSystemPrompt("python", "hexagonal", "auto", "auto", ctx);
  assert.match(p, /PROP[ÓO]SITO DO PROJETO/i);
  assert.match(p, /Agente de IA para P&D/);
  assert.match(p, /DEPEND[ÊE]NCIAS J[ÁA] FIXADAS/i);
  assert.match(p, /fastapi==0\.110\.0/);
  // sem contexto (compat retroativa): nada de propósito/deps
  assert.ok(!buildBlueprintSystemPrompt("python", "hexagonal").includes("PROPÓSITO DO PROJETO"));
});

test("buildProjectFromBlueprintPrompt: injeta contexto + regra NO_PHANTOM_SYMBOL", () => {
  const ctx = { purpose: "Sistema de recomendação interno", pinnedDeps: ["numpy==1.26.4"] };
  const guided = buildProjectFromBlueprintPrompt("proj", "python", "hexagonal", [{ path: "a.py", purpose: "p", deps: [] }], "auto", "auto", ctx);
  assert.match(guided, /Sistema de recomenda[çc][ãa]o interno/);
  assert.match(guided, /numpy==1\.26\.4/);
  assert.match(guided, /COER[ÊE]NCIA DE S[ÍI]MBOLOS/i); // NO_PHANTOM_SYMBOL
  assert.match(guided, /OrderStatus/); // cita o vetor exato do drift
  assert.match(guided, /ImportError\/AttributeError/);
});

test("buildProjectPrompt: regra NO_PHANTOM_SYMBOL presente (com e sem contexto)", () => {
  assert.match(buildProjectPrompt("proj", "python", "hexagonal"), /COER[ÊE]NCIA DE S[ÍI]MBOLOS/i);
  const withCtx = buildProjectPrompt("proj", "python", "hexagonal", "auto", "auto", { purpose: "X do domínio Y", pinnedDeps: [] });
  assert.match(withCtx, /X do dom[íi]nio Y/);
  assert.match(withCtx, /COER[ÊE]NCIA DE S[ÍI]MBOLOS/i);
});

test("buildProjectPrompt ajusta arquitetura, manifesto e interface por linguagem", () => {
  const go = buildProjectPrompt("p", "go", "clean");
  assert.match(go, /\bGo\b/);
  assert.match(go, /clean/i);
  assert.match(go, /interface Go/);
  assert.match(go, /go\.mod/);
  const ts = buildProjectPrompt("p", "typescript", "mvc");
  assert.match(ts, /MVC/i);
  assert.match(ts, /package\.json/);
});
