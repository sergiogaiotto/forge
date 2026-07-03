import assert from "node:assert/strict";
import { test } from "node:test";
import type { CharterSections, DiffProposal, ExtToWebview } from "../shared/protocol";
import { initialState, reducer, type UIState } from "../../webview-ui/src/state";

const EMPTY_CHARTER: CharterSections = { purpose: "", rules: "", fr: "", nfr: "" };

test("charter: state → drafting → drafted atualiza a seção e o status; edit é local", () => {
  let s = reducer(initialState, { kind: "ext", msg: { type: "charter/state", sections: { ...EMPTY_CHARTER, purpose: "inicial" } } });
  assert.equal(s.charter?.sections.purpose, "inicial");
  assert.equal(s.charter?.drafting.fr, false);
  // pediu para redigir FR → drafting.fr = true
  s = reducer(s, { kind: "ext", msg: { type: "charter/drafting", section: "fr" } });
  assert.equal(s.charter?.drafting.fr, true);
  // modelo respondeu → texto entra e drafting volta a false
  s = reducer(s, { kind: "ext", msg: { type: "charter/drafted", section: "fr", text: "- RF-01: autenticar" } });
  assert.equal(s.charter?.sections.fr, "- RF-01: autenticar");
  assert.equal(s.charter?.drafting.fr, false);
  // edição local do textarea
  s = reducer(s, { kind: "charter/edit", section: "purpose", text: "novo propósito" });
  assert.equal(s.charter?.sections.purpose, "novo propósito");
});

test("inspect: skills/inspect + skills/body + rag/inspect + rag/file preenchem o estado do viewer", () => {
  let s = reducer(initialState, {
    kind: "ext",
    msg: { type: "skills/inspect", skills: [{ name: "sql", description: "d", source: "workspace", enabled: true, relFile: "/x/SKILL.md", validators: [] }] },
  });
  assert.equal(s.inspect?.skills[0].name, "sql");
  s = reducer(s, { kind: "ext", msg: { type: "skills/body", name: "sql", body: "# corpo" } });
  assert.equal(s.inspect?.skillBody["sql"], "# corpo");
  s = reducer(s, {
    kind: "ext",
    msg: {
      type: "rag/inspect",
      index: { enabled: true, ready: true, mode: "lexical", files: 2, chunks: 5, maxChunks: 4000, capped: false, embeddingsUrl: "", embeddingModel: "m", dimensions: 0, fileList: [{ relPath: "a.py", language: "python", chunks: 3 }] },
    },
  });
  assert.equal(s.inspect?.rag?.files, 2);
  assert.equal(s.inspect?.rag?.fileList[0].relPath, "a.py");
  s = reducer(s, { kind: "ext", msg: { type: "rag/file", relPath: "a.py", chunks: [{ id: "a.py#1", startLine: 1, endLine: 9, hasVector: false, preview: "x=1" }] } });
  assert.equal(s.inspect?.ragFile["a.py"][0].id, "a.py#1");
  // preservou skills ao receber os dados de RAG (merge, não reset)
  assert.equal(s.inspect?.skills[0].name, "sql");

  // reabrir o Índice (nova skills/inspect + rag/inspect) INVALIDA os caches de corpo/chunks (evita stale)
  s = reducer(s, { kind: "ext", msg: { type: "skills/inspect", skills: [{ name: "sql", description: "d2", source: "workspace", enabled: false, relFile: "workspace/sql/SKILL.md", validators: [] }] } });
  assert.deepEqual(s.inspect?.skillBody, {}, "skills/inspect zera o cache de corpos");
  s = reducer(s, {
    kind: "ext",
    msg: { type: "rag/inspect", index: { enabled: true, ready: true, mode: "lexical", files: 1, chunks: 1, maxChunks: 4000, capped: false, embeddingsUrl: "", embeddingModel: "m", dimensions: 0, fileList: [] } },
  });
  assert.deepEqual(s.inspect?.ragFile, {}, "rag/inspect zera o cache de chunks");
});

test("charter/error ancora o erro NA SEÇÃO (in-modal) e limpa o drafting; toast só sem wizard", () => {
  let s = reducer(initialState, { kind: "ext", msg: { type: "charter/state", sections: EMPTY_CHARTER } });
  s = reducer(s, { kind: "ext", msg: { type: "charter/drafting", section: "nfr" } });
  s = reducer(s, { kind: "ext", msg: { type: "charter/error", section: "nfr", message: "sem licença" } });
  assert.equal(s.charter?.drafting.nfr, false);
  // O erro fica DENTRO do modal, na seção (um toast renderizaria atrás do backdrop e sumiria em 5s).
  assert.equal(s.charter?.notes.nfr?.level, "error");
  assert.match(s.charter?.notes.nfr?.message ?? "", /sem licença/);
  assert.equal(s.toast, null);
  // Sem wizard aberto (charter null), cai no fallback de toast para o erro não se perder.
  const noWizard = reducer(initialState, { kind: "ext", msg: { type: "charter/error", section: "nfr", message: "sem licença" } });
  assert.equal(noWizard.toast?.level, "error");
});

test("charter/drafted com warning anota a seção; redigir de novo ou editar dá baixa na nota", () => {
  let s = reducer(initialState, { kind: "ext", msg: { type: "charter/state", sections: EMPTY_CHARTER } });
  s = reducer(s, { kind: "ext", msg: { type: "charter/drafted", section: "fr", text: "- RF-01: parcial", warning: "truncou no limite de tokens" } });
  assert.equal(s.charter?.sections.fr, "- RF-01: parcial");
  assert.equal(s.charter?.notes.fr?.level, "warn");
  // Editar a seção (dev viu e está corrigindo) limpa a nota…
  s = reducer(s, { kind: "charter/edit", section: "fr", text: "- RF-01: corrigido" });
  assert.equal(s.charter?.notes.fr, undefined);
  // …e um novo rascunho SEM warning também não deixa nota para trás.
  s = reducer(s, { kind: "ext", msg: { type: "charter/drafting", section: "fr" } });
  s = reducer(s, { kind: "ext", msg: { type: "charter/drafted", section: "fr", text: "- RF-01: completo" } });
  assert.equal(s.charter?.notes.fr, undefined);
});

// REGRESSÃO (verificação adversarial): charter/drafted com texto VAZIO nunca pode sobrescrever o
// rascunho digitado (defesa em profundidade — o Controller já converte vazio em charter/error, mas
// se esse guard regredir, o reducer é a última linha antes da perda irreversível do textarea).
test("charter/drafted VAZIO preserva o rascunho do dev e anota erro na seção", () => {
  let s = reducer(initialState, { kind: "ext", msg: { type: "charter/state", sections: EMPTY_CHARTER } });
  s = reducer(s, { kind: "charter/edit", section: "fr", text: "- RF-01: rascunho digitado pelo dev" });
  s = reducer(s, { kind: "ext", msg: { type: "charter/drafting", section: "fr" } });
  s = reducer(s, { kind: "ext", msg: { type: "charter/drafted", section: "fr", text: "" } });
  assert.equal(s.charter?.sections.fr, "- RF-01: rascunho digitado pelo dev"); // NÃO apagou
  assert.equal(s.charter?.drafting.fr, false); // spinner desligado
  assert.equal(s.charter?.notes.fr?.level, "error"); // dev sabe por que nada mudou
  // Só-espaços conta como vazio também.
  s = reducer(s, { kind: "ext", msg: { type: "charter/drafted", section: "fr", text: "   \n  " } });
  assert.equal(s.charter?.sections.fr, "- RF-01: rascunho digitado pelo dev");
});

test("project/blueprint com warning exibe o aviso in-modal; aprovar (generating) dá baixa", () => {
  let s = reducer(initialState, { kind: "project/planning", brief: { text: "app", language: "python", architecture: "hexagonal" } });
  s = reducer(s, {
    kind: "ext",
    msg: {
      type: "project/blueprint",
      blueprint: { language: "python", architecture: "hexagonal", brief: "app", files: [{ path: "a.py", purpose: "", deps: [], status: "pending" }] },
      warning: "plano parcial — revise",
    },
  });
  assert.match(s.project?.warning ?? "", /plano parcial/);
  s = reducer(s, { kind: "project/generating" });
  assert.equal(s.project?.warning, undefined);
});

// Aplica uma sequência de mensagens do host (ExtToWebview) ao reducer da webview.
function apply(state: UIState, ...msgs: ExtToWebview[]): UIState {
  return msgs.reduce((s, msg) => reducer(s, { kind: "ext", msg }), state);
}

// Paleta "/": usage do stream/end acumula na sessão; context/report vira mensagem local do assistente.
test("stream/end com usage acumula na sessão; sem usage preserva o estado", () => {
  let s = apply(initialState, { type: "stream/start", taskId: "t1" });
  s = apply(s, { type: "stream/end", taskId: "t1", usage: { inputTokens: 1000, outputTokens: 200 } });
  assert.deepEqual(s.usage, { lastIn: 1000, lastOut: 200, sessionIn: 1000, sessionOut: 200 });
  s = apply(s, { type: "stream/start", taskId: "t2" }, { type: "stream/end", taskId: "t2", usage: { inputTokens: 500, outputTokens: 100 } });
  assert.deepEqual(s.usage, { lastIn: 500, lastOut: 100, sessionIn: 1500, sessionOut: 300 });
  const before = s.usage;
  s = apply(s, { type: "stream/start", taskId: "t3" }, { type: "stream/end", taskId: "t3" }); // sem usage
  assert.deepEqual(s.usage, before);
});

test("context/report adiciona um cartão local do assistente com o relatório", () => {
  const s = apply(initialState, {
    type: "context/report",
    report: {
      modelId: "m",
      contextWindow: 131072,
      outputReserve: 32768,
      inputBudget: 85196,
      pinnedTokens: 100,
      historyTokens: 50,
      historyTurns: 1,
      attachments: 0,
      attachmentTokens: 0,
      ragChunks: 0,
      sessionInputTokens: 0,
      sessionOutputTokens: 0,
    },
  });
  const last = s.messages[s.messages.length - 1];
  assert.equal(last.role, "assistant");
  assert.equal(last.streaming, false);
  assert.match(last.text, /Janela de contexto/);
});

test("pushLocal adiciona mensagem local do assistente (cartões /ajuda e /tokens)", () => {
  const s = reducer(initialState, { kind: "pushLocal", text: "### Paleta" });
  assert.equal(s.messages.length, 1);
  assert.equal(s.messages[0].role, "assistant");
  assert.match(s.messages[0].text, /Paleta/);
});

const PROPOSAL: DiffProposal = {
  id: "p1",
  filePath: "churn.py",
  language: "python",
  original: "",
  modified: "x = 1",
  summary: "novo",
  activatedSkills: [],
};

// Estado com uma proposta (via stream/start + stream/proposal), como na geração real.
function stateWithProposal(): UIState {
  return apply(
    initialState,
    { type: "stream/start", taskId: "t1" },
    { type: "stream/proposal", taskId: "t1", proposal: PROPOSAL },
    { type: "stream/end", taskId: "t1" }
  );
}

function proposalRun(state: UIState) {
  return state.messages.flatMap((m) => m.proposals).find((p) => p.proposal.id === "p1")?.run;
}

test("run/start marca o cartão da proposta como running (botão trava) e guarda o `where`", () => {
  const s = apply(stateWithProposal(), {
    type: "run/start",
    runId: "r1",
    proposalId: "p1",
    filePath: "churn.py",
    command: "python churn.py",
    where: "terminal",
  });
  const run = proposalRun(s);
  assert.equal(run?.running, true);
  assert.equal(run?.where, "terminal");
  assert.equal(run?.runId, "r1");
});

test("run/output concatena a saída ao vivo no cartão certo (por runId)", () => {
  let s = apply(stateWithProposal(), { type: "run/start", runId: "r1", proposalId: "p1", filePath: "churn.py", command: "c", where: "panel" });
  s = apply(s, { type: "run/output", runId: "r1", delta: "linha 1\n" }, { type: "run/output", runId: "r1", delta: "linha 2" });
  assert.equal(proposalRun(s)?.output, "linha 1\nlinha 2");
});

test("run/result finaliza o cartão ao vivo no lugar (running=false, exit code)", () => {
  let s = apply(stateWithProposal(), { type: "run/start", runId: "r1", proposalId: "p1", filePath: "churn.py", command: "c", where: "terminal" });
  s = apply(s, { type: "run/output", runId: "r1", delta: "parcial" });
  s = apply(s, {
    type: "run/result",
    runId: "r1",
    proposalId: "p1",
    filePath: "churn.py",
    command: "c",
    ok: true,
    exitCode: 0,
    output: "saída final",
    durationMs: 42,
  });
  const run = proposalRun(s);
  assert.equal(run?.running, false);
  assert.equal(run?.ok, true);
  assert.equal(run?.output, "saída final");
  assert.equal(run?.where, "terminal"); // preservado do run/start
  // não duplicou: continua um único cartão na proposta
  assert.equal(proposalRun(s) !== undefined, true);
});

test("run sem proposalId vai para a lista solta (runs) e finaliza no lugar", () => {
  let s = apply(initialState, { type: "run/start", runId: "r9", filePath: "x.py", command: "c", where: "panel" });
  assert.equal(s.runs.length, 1);
  assert.equal(s.runs[0].running, true);
  s = apply(s, { type: "run/result", runId: "r9", filePath: "x.py", command: "c", ok: false, exitCode: 1, output: "boom", durationMs: 5 });
  assert.equal(s.runs.length, 1); // mesmo cartão, não um novo
  assert.equal(s.runs[0].running, false);
  assert.equal(s.runs[0].ok, false);
  assert.equal(s.runs[0].exitCode, 1);
});

test("run/result sem run/start prévio (ex.: skipped) ainda cria o cartão", () => {
  const s = apply(stateWithProposal(), {
    type: "run/result",
    runId: "rx",
    proposalId: "p1",
    filePath: "churn.py",
    command: "",
    ok: false,
    exitCode: null,
    output: "",
    durationMs: 0,
    skippedReason: "Tipo sem comando",
  });
  assert.equal(proposalRun(s)?.skippedReason, "Tipo sem comando");
  assert.equal(proposalRun(s)?.running, false);
});

test("run de teste (label=testes) atualiza lastTestRun, não lastFileRun", () => {
  const s = apply(initialState, {
    type: "run/result",
    filePath: "",
    label: "testes",
    command: "pytest",
    ok: true,
    exitCode: 0,
    output: "5 passed",
    durationMs: 100,
  });
  assert.equal(s.lastTestRun?.ok, true);
  assert.equal(s.lastFileRun, null);
});

test("run de 'ambiente' (Preparar ambiente) NÃO polui lastFileRun nem lastTestRun (chip Executa neutro)", () => {
  // um run de arquivo real primeiro (label indefinido) alimenta lastFileRun
  let s = apply(initialState, { type: "run/result", filePath: "app.py", command: "python app.py", ok: true, exitCode: 0, output: "", durationMs: 3 });
  assert.equal(s.lastFileRun?.filePath, "app.py");
  // "Preparar ambiente" chega com label "ambiente" — não deve sobrescrever lastFileRun
  s = apply(s, { type: "run/result", filePath: "", label: "ambiente", command: "python -m venv .venv", ok: true, exitCode: 0, output: "ok", durationMs: 50 });
  assert.equal(s.lastFileRun?.filePath, "app.py", "ambiente não deve virar o 'último arquivo executado'");
  assert.equal(s.lastTestRun, null);
  // mas o cartão de ambiente aparece na lista solta (pode ser Ocultado)
  assert.ok(s.runs.some((r) => r.label === "ambiente"));
});

test("suíte de testes é SINGLETON: rodar várias vezes não empilha cartões (corrige acúmulo)", () => {
  let s: UIState = initialState;
  // simula o print: 3 execuções de teste seguidas (exit 5, 3, 0)
  for (const exitCode of [5, 3, 0]) {
    s = apply(s, {
      type: "run/result",
      filePath: "",
      label: "testes",
      command: "pytest -q",
      ok: exitCode === 0,
      exitCode,
      output: `exit ${exitCode}`,
      durationMs: 10,
    });
  }
  const testCards = s.runs.filter((r) => r.label === "testes");
  assert.equal(testCards.length, 1); // um único cartão, não três botões "Corrigir com FORGE"
  assert.equal(testCards[0].exitCode, 0); // reflete a ÚLTIMA execução
  assert.equal(testCards[0].ok, true);
  const idAfter = testCards[0].id;
  // re-rodar mantém o mesmo id (key estável no React)
  s = apply(s, { type: "run/result", filePath: "", label: "testes", command: "pytest -q", ok: false, exitCode: 1, output: "exit 1", durationMs: 9 });
  const after = s.runs.filter((r) => r.label === "testes");
  assert.equal(after.length, 1);
  assert.equal(after[0].id, idAfter);
  assert.equal(after[0].exitCode, 1);
});

test("cap: a lista de execuções não cresce sem limite e nunca descarta um cartão ao vivo", () => {
  let s: UIState = initialState;
  // um cartão ao vivo (running) criado primeiro
  s = apply(s, { type: "run/start", runId: "live", filePath: "live.py", command: "c", where: "panel" });
  // muitas execuções soltas finalizadas depois, que empurrariam o "live" para fora da janela
  for (let i = 0; i < 14; i++) {
    s = apply(s, { type: "run/result", runId: `r${i}`, filePath: `f${i}.py`, command: "c", ok: true, exitCode: 0, output: "", durationMs: 1 });
  }
  assert.equal(s.runs.length, 9); // aritmética exata: 8 do tail + 1 running preservado fora da janela
  const live = s.runs.find((r) => r.runId === "live");
  assert.ok(live, "o cartão ao vivo (running) deve ser preservado pelo cap");
  assert.equal(live?.running, true);
});

test("singleton só vale para 'testes': runs de arquivo distintos NÃO são fundidos", () => {
  let s: UIState = initialState;
  // duas execuções de arquivos diferentes, soltas (sem proposalId/runId, label != testes)
  s = apply(s, { type: "run/result", filePath: "a.py", command: "python a.py", ok: true, exitCode: 0, output: "", durationMs: 1 });
  s = apply(s, { type: "run/result", filePath: "b.py", command: "python b.py", ok: false, exitCode: 1, output: "", durationMs: 1 });
  assert.equal(s.runs.length, 2); // não coalesce — cada arquivo tem seu cartão
  // e o singleton de testes convive sem afetar os de arquivo
  s = apply(s, { type: "run/result", filePath: "", label: "testes", command: "pytest", ok: true, exitCode: 0, output: "", durationMs: 1 });
  assert.equal(s.runs.filter((r) => r.label === "testes").length, 1);
  assert.equal(s.runs.length, 3);
});

// ---- Modo Projeto: auto-desmarcar (project/appliedAll) e fechar sem erro (project/closed) ----

test("project/appliedAll incrementa appliedAllAt (seq) a cada aplicação — dispara o auto-desmarcar", () => {
  assert.equal(initialState.appliedAllAt, 0); // guard do useEffect ignora 0 na montagem
  let s = apply(initialState, { type: "project/appliedAll" });
  assert.equal(s.appliedAllAt, 1);
  // 2º projeto na mesma sessão: o valor SOBE → a dependência [state.appliedAllAt] muda → efeito dispara de novo
  s = apply(s, { type: "project/appliedAll" });
  assert.equal(s.appliedAllAt, 2);
});

const BRIEF = { text: "gerenciador de senhas", language: "python" as const, architecture: "hexagonal" as const };

test("project/closed fecha o modal do projeto SEM toast de erro (diferente de blueprintError)", () => {
  // abre o modal (planning) e então recebe o fechamento silencioso do host (redirecionado ao chat)
  let s = reducer(initialState, { kind: "project/planning", brief: BRIEF });
  assert.ok(s.project, "modal aberto ao planejar");
  s = apply(s, { type: "project/closed" });
  assert.equal(s.project, null, "modal fechado");
  assert.equal(s.toast, null, "sem toast de erro (ao contrário de project/blueprintError)");
});

test("project/blueprintError MANTÉM o modal aberto com o erro + brief retido (não some 'sem nada')", () => {
  let s = reducer(initialState, { kind: "project/planning", brief: BRIEF });
  s = apply(s, { type: "project/blueprintError", message: "resposta sem blueprint válido" });
  assert.ok(s.project, "modal continua aberto (não vira null)");
  assert.equal(s.project?.error, "resposta sem blueprint válido");
  assert.equal(s.project?.busy, false, "não fica travado em 'gerando'");
  assert.deepEqual(s.project?.brief, BRIEF, "brief retido para o 'Tentar de novo'");
  assert.equal(s.toast, null, "sem toast efêmero quando o modal está aberto");
  // blueprint chega no retry → limpa o erro, preserva o brief
  const bp = { ...BRIEF, brief: BRIEF.text, files: [{ path: "a.py", purpose: "", deps: [], status: "pending" as const }] };
  s = apply(s, { type: "project/blueprint", blueprint: bp });
  assert.equal(s.project?.error, undefined, "erro limpo ao chegar o blueprint");
  assert.deepEqual(s.project?.brief, BRIEF, "brief preservado");
});

test("project/blueprintError sem modal ativo cai no toast (fallback)", () => {
  const s = apply(initialState, { type: "project/blueprintError", message: "erro" });
  assert.equal(s.project, null);
  assert.equal(s.toast?.level, "error");
});

test("project/fileStatus patcha o status de UM arquivo (progresso um-a-um) sem tocar nos demais", () => {
  const bp = {
    language: "python" as const,
    architecture: "hexagonal" as const,
    brief: "x",
    files: [
      { path: "a.py", purpose: "", deps: [], status: "generating" as const },
      { path: "b.py", purpose: "", deps: [], status: "generating" as const },
    ],
  };
  let s = apply(initialState, { type: "project/blueprint", blueprint: bp });
  s = apply(s, { type: "project/fileStatus", path: "a.py", status: "complete" });
  assert.equal(s.project?.blueprint?.files.find((f) => f.path === "a.py")?.status, "complete");
  assert.equal(s.project?.blueprint?.files.find((f) => f.path === "b.py")?.status, "generating", "b.py intacto");
  // path inexistente → no-op (não quebra nem cria arquivo)
  s = apply(s, { type: "project/fileStatus", path: "z.py", status: "complete" });
  assert.equal(s.project?.blueprint?.files.length, 2);
});

test("project/planStep narra a etapa atual do planejamento (antes do blueprint chegar)", () => {
  let s = reducer(initialState, { kind: "project/planning", brief: BRIEF });
  assert.equal(s.project?.planStep, undefined, "sem etapa até o host narrar");
  s = apply(s, { type: "project/planStep", label: "Analisando os requisitos…" });
  assert.equal(s.project?.planStep, "Analisando os requisitos…");
  s = apply(s, { type: "project/planStep", label: "Ordenando por dependência…" });
  assert.equal(s.project?.planStep, "Ordenando por dependência…");
  // planStep sem projeto ativo é ignorado (no-op seguro)
  assert.equal(apply(initialState, { type: "project/planStep", label: "x" }).project, null);
});
