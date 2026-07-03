import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContextReport } from "../shared/protocol";
import {
  exactSlashCommand,
  matchSlashCommands,
  normalizeSlash,
  renderContextReport,
  renderHelp,
  renderTokensReport,
  SLASH_COMMANDS,
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
