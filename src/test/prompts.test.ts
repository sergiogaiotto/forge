import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildAcceptanceTestsRequest,
  buildBasePrompt,
  buildBlueprintRetryRequest,
  buildBlueprintSystemPrompt,
  buildCharterSystemPrompt,
  buildContinuationPrompt,
  buildProjectFromBlueprintPrompt,
  buildProjectPrompt,
  buildReviewPrompt,
  buildTailContinuation,
  buildTddPrompt,
  uiLayerInstruction,
} from "../core/systemPrompt";

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
  assert.match(p, /PRIMEIRO caractere/);
  assert.ok(p.includes("crie uma app de senhas"));
  assert.ok(p.includes("main.py, util.py"));
  // resposta anterior gigante é capada (teto de 4000) para não estourar a janela
  const big = buildBlueprintRetryRequest("brief", "x".repeat(20_000));
  assert.ok(big.length < 6000);
});

test("buildBlueprintRetryRequest: sem resposta anterior reforça o formato no pedido original", () => {
  const p = buildBlueprintRetryRequest("crie uma app de senhas", "   ");
  assert.match(p, /2ª tentativa/);
  assert.match(p, /APENAS com o array JSON/);
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

test("buildTailContinuation: manda emitir o restante dos arquivos, sem repetir nem reabrir bloco", () => {
  const p = buildTailContinuation();
  assert.match(p, /CONTINUE/);
  assert.match(p, /restante|próximos arquivos/i);
  assert.match(p, /NÃO reabra/i);
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
