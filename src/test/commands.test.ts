import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContextReport } from "../shared/protocol";
import {
  buildDbtTestsRequest,
  buildDiagramRequest,
  buildProjectSummaryRequest,
  buildSqlTranslateRequest,
  exactSlashCommand,
  matchSlashCommands,
  normalizeSlash,
  renderContextReport,
  renderHelp,
  renderSummarized,
  renderTokensReport,
  SLASH_COMMANDS,
  slashFullFormTail,
  slashWithArgs,
  commandHint,
  commandLabel,
  SQL_DIALECTS,
} from "../../webview-ui/src/commands";
import { setLocaleForTest } from "../../webview-ui/src/i18n";

// REFACTOR pré-i18n: a forma completa "/sumário projeto" deriva o tail esperado do label RESOLVIDO, então
// traduzir o label mantém a comparação em sincronia (nada de literal pt-BR hardcoded no controle).
test("slashFullFormTail: deriva a cauda do label; traduzir o label move o tail junto (sem literal fixo)", () => {
  assert.equal(slashFullFormTail("/sumário projeto"), "projeto"); // pt-BR
  assert.equal(slashFullFormTail("/x"), ""); // uma palavra → sem cauda
  assert.equal(slashFullFormTail("/summary project"), "project"); // label traduzido → tail acompanha
  assert.equal(slashFullFormTail("/Sumário Projeto"), "projeto"); // normaliza acento/caixa
});

test("commandLabel/commandHint: pt-BR usa a fonte do array; en usa o override (id/aliases nunca mudam)", () => {
  const limpar = SLASH_COMMANDS.find((c) => c.id === "limpar")!;
  setLocaleForTest("pt-BR");
  assert.equal(commandLabel(limpar), "/limpar");
  assert.equal(commandHint(limpar), "Limpa a conversa DE VERDADE (histórico e anexos do host)");
  setLocaleForTest("en");
  assert.equal(commandLabel(limpar), "/clear"); // label en bate com o alias "clear" (matching continua)
  assert.match(commandHint(limpar), /^Clear the conversation/);
  // o id e os aliases (matching) NÃO mudam com o locale
  assert.equal(limpar.id, "limpar");
  assert.ok((limpar.aliases ?? []).includes("clear"));
  setLocaleForTest("pt-BR");
});

// GUARD: o matching usa id/aliases, NÃO o label. Se um label traduzido não casa um id/alias, o usuário
// vê o comando na paleta mas digitá-lo dá "comando desconhecido". Todo label (pt-BR E en) DEVE ser
// executável via exactSlashCommand — para os de UMA palavra (os de duas, como "/sumário projeto", casam
// pela cauda em slashWithArgs, coberto à parte).
test("guard: todo label (pt-BR e en) de uma palavra é executável (casa id/alias no matching)", () => {
  for (const loc of ["pt-BR", "en"] as const) {
    setLocaleForTest(loc);
    for (const c of SLASH_COMMANDS) {
      const label = commandLabel(c);
      if (/\s/.test(label.trim())) continue; // formas de duas palavras casam pela cauda (slashWithArgs)
      const resolved = exactSlashCommand(label);
      assert.ok(resolved, `[${loc}] label "${label}" (id ${c.id}) não é executável — falta id/alias`);
      assert.equal(resolved!.id, c.id, `[${loc}] label "${label}" casa o comando ERRADO (${resolved!.id} != ${c.id})`);
    }
  }
  setLocaleForTest("pt-BR");
});

test("renderHelp: usa o label/hint do locale ativo e o frame traduzido", () => {
  setLocaleForTest("en");
  const en = renderHelp();
  assert.match(en, /Command palette/);
  assert.match(en, /\/clear/); // label en
  assert.match(en, /Type `\/` in the chat/);
  setLocaleForTest("pt-BR");
  const pt = renderHelp();
  assert.match(pt, /Paleta de comandos/);
  assert.match(pt, /\/limpar/);
});

test("normalizeSlash: remove acentos e baixa a caixa (/Sumário ≡ /sumario)", () => {
  assert.equal(normalizeSlash("Sumário"), "sumario");
  assert.equal(normalizeSlash("ÍNDICE"), "indice");
  assert.equal(normalizeSlash("ção"), "cao");
});

test("matchSlashCommands: prefixo filtra; '/' sozinho lista tudo; sem '/' não abre", () => {
  assert.equal(matchSlashCommands("/").length, SLASH_COMMANDS.length);
  assert.deepEqual(matchSlashCommands("/lim").map((c) => c.id), ["limpar"]);
  assert.deepEqual(matchSlashCommands("/te").map((c) => c.id), ["testes", "testes-dbt"]);
  assert.deepEqual(matchSlashCommands("olá"), []);
  // acento no que foi digitado não atrapalha
  assert.deepEqual(matchSlashCommands("/índ").map((c) => c.id), ["indice"]);
  // alias
  assert.ok(matchSlashCommands("/cle").some((c) => c.id === "limpar"));
});

test("exactSlashCommand: só o comando NU e exato executa — cauda é mensagem do dev, typo não roda nada", () => {
  assert.equal(exactSlashCommand("/limpar")?.id, "limpar");
  assert.equal(exactSlashCommand("/LIMPAR")?.id, "limpar");
  assert.equal(exactSlashCommand("/clear")?.id, "limpar"); // alias
  assert.equal(exactSlashCommand("/indice")?.id, "indice");
  assert.equal(exactSlashCommand("/índice")?.id, "indice"); // com acento
  assert.equal(exactSlashCommand("/limpr"), undefined); // typo → não executa
  assert.equal(exactSlashCommand("limpar"), undefined); // sem "/"
  // REGRESSÃO (revisão adversarial): "/testes estão falhando — por quê?" é PERGUNTA, não comando —
  // executar a suíte e descartar o texto seria sequestro. Cauda (espaço/linha) → não é comando.
  assert.equal(exactSlashCommand("/tokens agora"), undefined);
  assert.equal(exactSlashCommand("/testes estão falhando com ImportError"), undefined);
  assert.equal(exactSlashCommand("/limpar\ndepois analise o log"), undefined);
});

const REPORT: ContextReport = {
  modelId: "openai/gpt-oss-120b",
  contextWindow: 131072,
  outputReserve: 32768,
  inputBudget: 85196,
  pinnedTokens: 2400,
  historyTokens: 1200,
  historyTurns: 3,
  attachments: 1,
  attachmentTokens: 4000,
  ragChunks: 98,
  sessionInputTokens: 15000,
  sessionOutputTokens: 6200,
};

test("renderContextReport: markdown com janela, reservas, histórico, anexos, barra e sessão", () => {
  const md = renderContextReport(REPORT);
  assert.ok(md.includes("openai/gpt-oss-120b"));
  assert.ok(md.includes("131.1k")); // janela
  assert.ok(md.includes("32.8k")); // reserva de saída
  assert.ok(md.includes("3 turnos"));
  assert.ok(md.includes("Anexos pendentes (1)")); // anexos entram na tabela E na barra
  assert.ok(md.includes("4.0k"));
  assert.ok(md.includes("98 chunks"));
  assert.ok(md.includes("█") || md.includes("░")); // barra visual
  assert.ok(md.includes("/limpar"));
  // sem anexos, a linha some
  assert.ok(!renderContextReport({ ...REPORT, attachments: 0, attachmentTokens: 0 }).includes("Anexos pendentes"));
});

test("renderTokensReport: vazio orienta; com dados mostra última geração e acumulado", () => {
  assert.match(renderTokensReport(null), /Ainda não houve geração/);
  const md = renderTokensReport({ lastIn: 1200, lastOut: 300, sessionIn: 5000, sessionOut: 900 });
  assert.ok(md.includes("1.2k"));
  assert.ok(md.includes("5.0k"));
});

test("renderHelp: lista todos os comandos do registry", () => {
  const md = renderHelp();
  for (const c of SLASH_COMMANDS) assert.ok(md.includes(c.label), `faltou ${c.label}`);
});

// ---- Fase 2 da paleta ----

test("slashWithArgs: só comandos acceptsArgs aceitam cauda; os demais seguem a regra anti-sequestro", () => {
  const d = slashWithArgs("/diagrama fluxo de autenticação");
  assert.equal(d?.cmd.id, "diagrama");
  assert.equal(d?.args, "fluxo de autenticação");
  assert.equal(slashWithArgs("/mermaid pipeline de dados")?.cmd.id, "diagrama"); // alias
  // /testes tem cauda mas NÃO aceita args → undefined (a mensagem vai ao modelo)
  assert.equal(slashWithArgs("/testes estão falhando"), undefined);
  assert.equal(slashWithArgs("/diagrama"), undefined); // sem cauda → caminho do comando nu
  assert.equal(slashWithArgs("diagrama x"), undefined); // sem "/"
});

test("buildDiagramRequest: pede UM arquivo docs/diagramas/<slug>.md com bloco mermaid; slug saneado", () => {
  const req = buildDiagramRequest("Fluxo de Autenticação!");
  assert.match(req, /docs\/diagramas\/fluxo-de-autenticacao\.md/);
  assert.match(req, /```mermaid/);
  assert.match(req, /NÃO gere nenhum outro arquivo/);
  // tema vazio → default de arquitetura
  assert.match(buildDiagramRequest(""), /docs\/diagramas\/arquitetura/);
});

// Adendo 1 do plano: "/sumário projeto" — documentação funcional padrão de mercado.
test("/sumário projeto: casa com e sem acento, nu ou com a cauda 'projeto'", () => {
  assert.equal(exactSlashCommand("/sumario")?.id, "sumario");
  assert.equal(exactSlashCommand("/sumário")?.id, "sumario");
  assert.equal(slashWithArgs("/sumário projeto")?.cmd.id, "sumario");
  assert.equal(slashWithArgs("/sumario projeto")?.cmd.id, "sumario");
});

test("buildProjectSummaryRequest: pede docs/SUMARIO_FUNCIONAL.md com as 12 seções padrão de mercado", () => {
  const req = buildProjectSummaryRequest("2026-07-03");
  // a DATA vai no prompt (o modelo não tem relógio — sem ela o histórico sairia com data fabricada)
  assert.ok(req.includes("data 2026-07-03"));
  // prioridade nunca é inventada: só quando o charter declarar
  assert.match(req, /SÓ quando o charter a declarar/);
  assert.match(req, /docs\/SUMARIO_FUNCIONAL\.md/);
  for (const sec of [
    "Visão Geral e Objetivo de Negócio",
    "Escopo",
    "Personas e Usuários",
    "Funcionalidades",
    "Fluxos Principais",
    "Arquitetura e Módulos",
    "Modelo de Dados",
    "Requisitos Funcionais e Não Funcionais",
    "Integrações e Dependências",
    "Como Executar",
    "Glossário",
    "Histórico de Revisões",
  ]) {
    assert.ok(req.includes(sec), `faltou a seção ${sec}`);
  }
  assert.match(req, /```mermaid/); // fluxo principal com diagrama
  assert.match(req, /FIEL ao código/); // anti-alucinação
  assert.match(req, /NÃO gere nenhum outro arquivo/);
});

test("renderSummarized: cartão explica a compactação e traz o resumo (concordância no singular)", () => {
  const md = renderSummarized(7, "- decisão A\n- pendência B");
  assert.match(md, /7 turnos viraram/);
  assert.ok(md.includes("- decisão A"));
  assert.ok(md.includes("/limpar"));
  assert.match(renderSummarized(1, "x"), /1 turno virou/);
});

// ---- comandos de dados (Ondas 1 e 2) --------------------------------------------------------------

test("/impacto, /traduzir-sql e /testes-dbt: registrados, com cauda como argumento", () => {
  assert.equal(exactSlashCommand("/impacto")?.id, "impacto");
  assert.equal(slashWithArgs("/impacto stg_orders")?.args, "stg_orders");
  assert.equal(slashWithArgs("/traduzir-sql bigquery")?.cmd.id, "traduzir-sql");
  assert.equal(slashWithArgs("/testes-dbt fct_pedidos")?.args, "fct_pedidos");
  // aliases
  assert.equal(exactSlashCommand("/impact")?.id, "impacto");
  assert.equal(exactSlashCommand("/dbt-tests")?.id, "testes-dbt");
});

test("buildSqlTranslateRequest: preservação semântica, sufixo do dialeto e forge-file único", () => {
  const req = buildSqlTranslateRequest("BigQuery");
  assert.match(req, /BIGQUERY/);
  assert.match(req, /\.bigquery\.sql/);
  assert.match(req, /NUNCA "otimize"/);
  assert.match(req, /-- REVISAR:/); // escape hatch: na dúvida, manter e avisar
  assert.match(req, /forge-file/);
  assert.match(req, /NÃO modifique o arquivo original/);
  assert.ok(SQL_DIALECTS.includes("bigquery"));
  assert.ok(SQL_DIALECTS.includes("snowflake"));
});

test("buildDbtTestsRequest: taxonomia coluna→teste, proíbe inventar coluna e segue estilo do projeto", () => {
  const req = buildDbtTestsRequest("stg_orders");
  assert.ok(req.includes("`stg_orders`"));
  assert.match(req, /Schema real do projeto dbt/); // ancora nas colunas REAIS injetadas pelo host
  assert.match(req, /NUNCA invente nomes de coluna/);
  assert.match(req, /`unique` \+ `not_null`/);
  assert.match(req, /relationships/);
  assert.match(req, /NÃO introduza dbt_utils/);
  const semAlvo = buildDbtTestsRequest("");
  assert.match(semAlvo, /ARQUIVO ATIVO/);
});
