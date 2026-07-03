import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContextReport } from "../shared/protocol";
import {
  buildDiagramRequest,
  buildProjectSummaryRequest,
  exactSlashCommand,
  matchSlashCommands,
  normalizeSlash,
  renderContextReport,
  renderHelp,
  renderSummarized,
  renderTokensReport,
  SLASH_COMMANDS,
  slashWithArgs,
} from "../../webview-ui/src/commands";

test("normalizeSlash: remove acentos e baixa a caixa (/Sumário ≡ /sumario)", () => {
  assert.equal(normalizeSlash("Sumário"), "sumario");
  assert.equal(normalizeSlash("ÍNDICE"), "indice");
  assert.equal(normalizeSlash("ção"), "cao");
});

test("matchSlashCommands: prefixo filtra; '/' sozinho lista tudo; sem '/' não abre", () => {
  assert.equal(matchSlashCommands("/").length, SLASH_COMMANDS.length);
  assert.deepEqual(matchSlashCommands("/lim").map((c) => c.id), ["limpar"]);
  assert.deepEqual(matchSlashCommands("/te").map((c) => c.id), ["testes"]);
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
