import * as fs from "node:fs/promises";
import * as path from "node:path";
import { LLMProvider } from "../api/types";
import { ChatMessage } from "../api/types";
import { gatePassed, SkillValidator } from "../skills/SkillValidator";
import { SkillValidatorSpec } from "../skills/types";
import { ObsEvent } from "../obs/types";
import { DiffProposal, ExtToWebview, ValidatorResult } from "../shared/protocol";
import { parseCellBlocks, parseNotebookCells } from "../util/cellBlocks";
import { CompletenessResult, partialFilePath, resilientGenerate } from "../util/completeness";
import { parseFileBlocks } from "../util/fileBlocks";
import { log } from "../util/logger";
import { safeWorkspacePath } from "../util/safePath";
import { buildContinuationPrompt, buildTailContinuation } from "./systemPrompt";

// Máximo de re-pedidos de continuação quando um arquivo é cortado (cerca aberta). Prioridade é
// completude, não custo (decisão de produto), mas com teto rígido + guarda de "stall" (passagem que
// não avança) para nunca entrar em loop infinito nem custo descontrolado.
const MAX_CONTINUATIONS = 6;
// Ao pedir a continuação, reenviamos apenas a CAUDA do texto acumulado como âncora (não o arquivo
// inteiro): evita inflar a ENTRADA a cada rodada e estourar a janela do servidor (HTTP 400). A cauda
// dá contexto de sobra para o modelo continuar, e o stitch (teto 400) dedupa a sobreposição.
const CONTINUATION_ANCHOR_CHARS = 8000;

let proposalCounter = 0;

export interface TaskDeps {
  taskId: string;
  provider: LLMProvider;
  systemPrompt: string;
  messages: ChatMessage[];
  activatedSkillNames: string[];
  validators: SkillValidatorSpec[];
  skillValidator: SkillValidator;
  workspaceRoot: string | undefined;
  timeoutMs: number;
  extraHeaders?: Record<string, string>;
  post: (msg: ExtToWebview) => void;
  emit?: (e: ObsEvent) => void; // observabilidade (geração + workflow)
  obsMeta?: { mode: "normal" | "tdd" | "review" | "project"; model: string; provider: string; sessionId: string; userId: string; org?: string };
}

const LANG_BY_EXT: Record<string, string> = {
  ".py": "python", ".ipynb": "python", ".sql": "sql", ".ts": "typescript", ".js": "javascript",
  ".json": "json", ".yaml": "yaml", ".yml": "yaml", ".md": "markdown", ".sh": "bash", ".r": "r", ".scala": "scala",
};

export class Task {
  private readonly controller = new AbortController();
  // Propostas geradas nesta task, mantidas para que o Controller possa aplicá-las/validá-las.
  // `cellIndex` é resolvido na aplicação de uma proposta de célula (para executá-la depois).
  readonly proposals = new Map<
    string,
    { proposal: DiffProposal; results: ValidatorResult[]; gateOk: boolean; cellIndex?: number }
  >();

  constructor(private readonly deps: TaskDeps) {}

  abort(): void {
    this.controller.abort();
  }

  getProposal(id: string) {
    return this.proposals.get(id);
  }

  async run(): Promise<void> {
    const d = this.deps;
    const started = Date.now();
    const model = d.obsMeta?.model ?? "";
    const input = d.messages[d.messages.length - 1]?.content ?? "";
    d.post({ type: "stream/start", taskId: d.taskId });
    d.emit?.({
      type: "generation.start",
      taskId: d.taskId,
      mode: d.obsMeta?.mode ?? "normal",
      model,
      provider: d.obsMeta?.provider ?? "",
      skills: d.activatedSkillNames,
      sessionId: d.obsMeta?.sessionId ?? "",
      userId: d.obsMeta?.userId ?? "",
      org: d.obsMeta?.org,
    });
    for (const s of d.activatedSkillNames) {
      d.post({ type: "stream/skill", taskId: d.taskId, skill: s });
      d.emit?.({ type: "skill.activated", skill: s });
    }

    // Geração RESILIENTE: gera; se um arquivo ficou cortado (cerca de fechamento não veio), re-pede a
    // continuação e costura ao texto acumulado, até o arquivo fechar ou esgotar o teto de tentativas.
    // O usage é ACUMULADO entre as passagens — cada continuação reenvia contexto e tem custo próprio.
    let inputTokens = 0;
    let outputTokens = 0;
    const onUsage = (u: { inputTokens?: number; outputTokens?: number }) => {
      inputTokens += u.inputTokens ?? 0;
      outputTokens += u.outputTokens ?? 0;
    };
    const gen = await resilientGenerate(d.messages, (msgs) => this.streamOnce(msgs, onUsage), {
      maxContinuations: MAX_CONTINUATIONS,
      anchorChars: CONTINUATION_ANCHOR_CHARS,
      buildContinuation: buildContinuationPrompt,
      buildTailContinuation,
      onContinue: (attempt, path) =>
        d.post({ type: "stream/notice", taskId: d.taskId, level: "info", message: `Completando ${path ?? "o restante"} (continuação ${attempt}/${MAX_CONTINUATIONS})…` }),
      aborted: () => this.controller.signal.aborted,
    });
    const usage = { inputTokens, outputTokens };
    if (gen.error !== undefined) {
      d.post({ type: "stream/error", taskId: d.taskId, message: gen.error });
      d.emit?.({ type: "generation.end", taskId: d.taskId, durationMs: Date.now() - started, model, input, output: gen.full, usage, proposals: 0, error: gen.error });
      return;
    }
    const full = gen.full;
    const completeness: CompletenessResult = gen.completeness;

    // `truncated` cobre tanto o arquivo com cerca aberta quanto o corte ENTRE arquivos (provider sinalizou
    // finish_reason=length) — este último é o caso comum de um PROJETO que veio com arquivos faltando.
    const wasTruncated = gen.truncated;
    if (wasTruncated) {
      const alvo = completeness.path ? `(arquivo ${completeness.path})` : "(cortada por limite de tokens — pode faltar arquivo)";
      d.post({
        type: "stream/notice",
        taskId: d.taskId,
        level: "warn",
        message: `A geração pode estar incompleta ${alvo} após ${gen.attempts} continuações. Peça para continuar ou regenerar.`,
      });
    }

    // Faz o parse das edições de arquivo propostas e transforma cada uma em um diff revisável.
    const blocks = parseFileBlocks(full);
    // Qual proposta marcar como parcial. Só há parcial quando um arquivo ficou REALMENTE incompleto
    // (cerca aberta/elipse). Se o corte foi só ENTRE arquivos (todos fecharam; provider cortou por
    // tokens), nenhum bloco completo é rebaixado — corrige o "Aplicar tudo" pulando o README completo.
    const partialPath = partialFilePath(wasTruncated, completeness, full);
    for (const block of blocks) {
      const proposal = await this.makeProposal(block.path, block.content);
      if (partialPath && block.path === partialPath) proposal.partial = true;
      this.proposals.set(proposal.id, { proposal, results: [], gateOk: true });
      d.post({ type: "stream/proposal", taskId: d.taskId, proposal });
      d.emit?.({ type: "proposal.created", filePath: proposal.filePath, change: proposal.original ? "edição" : "novo", language: proposal.language });
      void this.validateProposal(proposal);
    }

    // Edições de CÉLULA de notebook (.ipynb).
    for (const cb of parseCellBlocks(full)) {
      const proposal = await this.makeCellProposal(cb);
      this.proposals.set(proposal.id, { proposal, results: [], gateOk: true });
      d.post({ type: "stream/proposal", taskId: d.taskId, proposal });
      d.emit?.({ type: "proposal.created", filePath: proposal.filePath, change: "célula", language: proposal.language });
    }

    d.emit?.({ type: "generation.end", taskId: d.taskId, durationMs: Date.now() - started, model, input, output: full, usage, proposals: this.proposals.size });
    d.post({ type: "stream/end", taskId: d.taskId });
  }

  // Uma passagem de streaming do provider: acumula e transmite o texto ao vivo, retornando o texto
  // desta chamada (o laço de continuação em run() costura as passagens). O aviso de truncamento do
  // provider é suprimido aqui — quem decide a mensagem (completar/parcial) é o laço, com base no
  // verificador de completude, evitando avisos redundantes/confusos entre uma continuação e outra.
  private async streamOnce(
    messages: ChatMessage[],
    onUsage: (u: { inputTokens?: number; outputTokens?: number }) => void
  ): Promise<{ text: string; error?: string; truncated: boolean }> {
    const d = this.deps;
    let text = "";
    let truncated = false;
    try {
      for await (const chunk of d.provider.createMessage(d.systemPrompt, messages, {
        timeoutMs: d.timeoutMs,
        signal: this.controller.signal,
        extraHeaders: d.extraHeaders,
      })) {
        switch (chunk.kind) {
          case "reasoning":
            d.post({ type: "stream/reasoning", taskId: d.taskId, delta: chunk.text });
            break;
          case "text":
            text += chunk.text;
            d.post({ type: "stream/text", taskId: d.taskId, delta: chunk.text });
            break;
          case "warning":
            truncated = true; // provider sinalizou corte por limite (finish_reason=length/max_tokens)
            break;
          case "error":
            return { text, error: chunk.message, truncated };
          case "usage":
            onUsage({ inputTokens: chunk.inputTokens, outputTokens: chunk.outputTokens });
            break;
          case "tool_call":
            break;
        }
      }
    } catch (err) {
      return { text, error: (err as Error).message, truncated };
    }
    return { text, truncated };
  }

  private async makeCellProposal(cb: import("../util/cellBlocks").CellBlock): Promise<DiffProposal> {
    const d = this.deps;
    let original = "";
    const safe = d.workspaceRoot ? safeWorkspacePath(d.workspaceRoot, cb.path) : null;
    if (cb.op === "replace" && cb.index !== undefined && safe) {
      try {
        const content = await fs.readFile(safe, "utf8");
        original = parseNotebookCells(content)[cb.index]?.source ?? "";
      } catch {
        original = "";
      }
    }
    const summary =
      cb.op === "add"
        ? `Nova célula${cb.after !== undefined ? ` após [${cb.after}]` : " (ao final)"}`
        : `Substituir célula [${cb.index}]`;
    return {
      id: `prop_${++proposalCounter}`,
      filePath: cb.path,
      language: "python",
      original,
      modified: cb.code,
      summary,
      activatedSkills: this.deps.activatedSkillNames,
      cell: { op: cb.op, index: cb.index, after: cb.after },
    };
  }

  private async makeProposal(relPath: string, content: string): Promise<DiffProposal> {
    const d = this.deps;
    let original = "";
    // Só lê o "original" se o caminho (vindo do modelo) estiver CONTIDO no workspace — não vaza conteúdo
    // de arquivos externos (`../`, absoluto) para o diff. A escrita é barrada de novo no applyProposal.
    const safe = d.workspaceRoot ? safeWorkspacePath(d.workspaceRoot, relPath) : null;
    if (safe) {
      try {
        original = await fs.readFile(safe, "utf8");
      } catch {
        original = "";
      }
    }
    const ext = path.extname(relPath).toLowerCase();
    return {
      id: `prop_${++proposalCounter}`,
      filePath: relPath,
      language: LANG_BY_EXT[ext] ?? "plaintext",
      original,
      modified: content,
      summary: original ? "Alteração proposta" : "Novo arquivo proposto",
      activatedSkills: d.activatedSkillNames,
    };
  }

  private async validateProposal(proposal: DiffProposal): Promise<void> {
    const d = this.deps;
    if (d.validators.length === 0) return;
    d.post({ type: "validation/result", proposalId: proposal.id, results: [], gateOk: true, running: true });
    try {
      const results = await d.skillValidator.run(d.validators, proposal.modified, proposal.filePath);
      const gateOk = gatePassed(results);
      const entry = this.proposals.get(proposal.id);
      if (entry) {
        entry.results = results;
        entry.gateOk = gateOk;
      }
      d.post({ type: "validation/result", proposalId: proposal.id, results, gateOk, running: false });
      d.emit?.({ type: "validation.result", filePath: proposal.filePath, gateOk, validators: results.map((r) => ({ id: r.id, status: r.status })) });
    } catch (err) {
      log.warn("Validação falhou", err);
      d.post({ type: "validation/result", proposalId: proposal.id, results: [], gateOk: true, running: false });
    }
  }
}
