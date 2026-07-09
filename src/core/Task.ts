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
import { closedBlockPaths, parseFileBlocks } from "../util/fileBlocks";
import { log } from "../util/logger";
import { detectProseFileEdit } from "../util/proseEdits";
import { safeWorkspacePath } from "../util/safePath";
import { estimateTokens } from "../util/tokenEstimate";
import { buildContinuationPrompt, buildProtocolReemitPrompt, buildTailContinuation } from "./systemPrompt";

// Máximo de re-pedidos de continuação quando um arquivo é cortado (cerca aberta). Prioridade é
// completude, não custo (decisão de produto), mas com teto rígido + guarda de "stall" (passagem que
// não avança) para nunca entrar em loop infinito nem custo descontrolado.
const MAX_CONTINUATIONS = 6;
// Ao pedir a continuação, reenviamos apenas a CAUDA do texto acumulado como âncora (não o arquivo
// inteiro): evita inflar a ENTRADA a cada rodada e estourar a janela do servidor (HTTP 400). A cauda
// dá contexto de sobra para o modelo continuar, e o stitch (teto 400) dedupa a sobreposição.
const CONTINUATION_ANCHOR_CHARS = 8000;
// Modo Projeto: re-parsear o texto acumulado para detectar arquivos fechados custa O(n) por vez; para
// não virar O(n²) no host, só re-parseia após crescer este tanto (o status um-a-um é cosmético — a
// reconciliação final é a autoridade, então um atraso de ~1 KB no dot é imperceptível).
const STATUS_SCAN_DELTA = 1200;

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
  // Chamado (Modo Projeto) assim que um bloco de arquivo FECHA no streaming — habilita o status
  // "gerando…" → "gerado" um a um no modal, em vez de tudo em lote no fim.
  onFileClosed?: (path: string) => void;
  // Validador IN-PROCESS (Onda 1 dados): o motor SQL determinístico analisa propostas .sql (anti-padrões,
  // segurança, schema dbt) sem spawnar processo — os resultados entram no MESMO canal dos validadores
  // de skill (cartão, gate, Langfuse). Opcional: só o Controller o injeta quando configurado.
  sqlAnalyzer?: (relPath: string, content: string) => Promise<ValidatorResult[]>;
  emit?: (e: ObsEvent) => void; // observabilidade (geração + workflow)
  obsMeta?: { mode: "normal" | "tdd" | "review" | "project"; model: string; provider: string; sessionId: string; userId: string; org?: string; reasoningEffort?: string; maxOutputTokens?: number; inputBudgetTokens?: number; ragMs?: number; assembleMs?: number };
}

const LANG_BY_EXT: Record<string, string> = {
  ".py": "python", ".ipynb": "python", ".sql": "sql", ".ts": "typescript", ".js": "javascript",
  ".json": "json", ".yaml": "yaml", ".yml": "yaml", ".md": "markdown", ".sh": "bash", ".r": "r", ".scala": "scala",
};

export class Task {
  private readonly controller = new AbortController();
  // Caminhos já notificados como "bloco fechado" (Modo Projeto), para não repetir o evento por arquivo.
  private readonly closedNotified = new Set<string>();
  // Texto COMPLETO gerado nesta run (P1 few-shot vivo): o Controller o lê após run() para empilhar um turno
  // compacto no histórico, preservando o formato forge-file para o próximo turno.
  private lastGenerated = "";
  // Propostas geradas nesta task, mantidas para que o Controller possa aplicá-las/validá-las.
  // `cellIndex` é resolvido na aplicação de uma proposta de célula (para executá-la depois).
  readonly proposals = new Map<
    string,
    { proposal: DiffProposal; results: ValidatorResult[]; gateOk: boolean; cellIndex?: number }
  >();
  // Validações por-arquivo disparadas em run() (fire-and-forget, para não travar o streaming). O gate
  // workspace-wide do Modo Projeto precisa AGUARDÁ-LAS antes de sobrescrever gateOk — senão uma validação
  // advisory que resolve tarde reescreveria o veredito do gate de volta para true (corrida real).
  private readonly pendingValidations: Promise<void>[] = [];

  // Aguarda todas as validações por-arquivo em voo (usado pelo gate do projeto antes de decidir gateOk).
  async settleValidations(): Promise<void> {
    await Promise.allSettled(this.pendingValidations);
  }

  constructor(private readonly deps: TaskDeps) {}

  abort(): void {
    this.controller.abort();
  }

  getProposal(id: string) {
    return this.proposals.get(id);
  }

  // taskId desta task — o host o usa para correlacionar propostas sintetizadas FORA do stream (ex.: o
  // botão "Salvar como arquivo" do CodeBox). O reducer da webview ignora o taskId ao anexar a proposta
  // (usa o último balão do assistente), mas o tipo da mensagem stream/proposal o exige.
  get taskId(): string {
    return this.deps.taskId;
  }

  // P1 few-shot vivo: o texto COMPLETO gerado nesta run (para o Controller montar o turno de histórico).
  getGenerated(): string {
    return this.lastGenerated;
  }

  // Botão "Salvar como arquivo" (Onda 3): o dev decidiu aplicar um trecho que o modelo mostrou em cerca
  // comum (não virou forge-file e o reparo automático não disparou). Sintetiza uma proposta REAL — o MESMO
  // pipeline de card/validação/gate/apply — a partir de um caminho CONFIRMADO pelo dev, nunca uma escrita
  // crua. A validação (fire-and-forget, como no run()) alimenta o gate como em qualquer proposta.
  async registerManualProposal(filePath: string, content: string): Promise<DiffProposal> {
    const proposal = await this.makeProposal(filePath, content);
    this.proposals.set(proposal.id, { proposal, results: [], gateOk: true });
    this.pendingValidations.push(this.validateProposal(proposal));
    return proposal;
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
      // P3: o prompt de sistema MONTADO (redigido no sink) + os params efetivos — evidência direta do que
      // produziu a geração. systemPromptTokens é o tamanho REAL (o sink pode capar o texto cru).
      systemPrompt: d.systemPrompt,
      systemPromptTokens: estimateTokens(d.systemPrompt),
      reasoningEffort: d.obsMeta?.reasoningEffort,
      maxOutputTokens: d.obsMeta?.maxOutputTokens,
      inputBudgetTokens: d.obsMeta?.inputBudgetTokens,
    });
    for (const s of d.activatedSkillNames) {
      d.post({ type: "stream/skill", taskId: d.taskId, skill: s });
      d.emit?.({ type: "skill.activated", skill: s });
    }
    // P3: spans de rag/assemble medidos no Controller ANTES do taskId existir, emitidos AQUI (após o
    // generation.start deste taskId) para anexarem ao trace CERTO — o Langfuse roteia phase.timing pelo
    // último trace aberto, que agora é o desta geração (achado da revisão: emiti-los cedo os punha no trace
    // anterior/órfão).
    if (d.obsMeta?.ragMs !== undefined) d.emit?.({ type: "phase.timing", taskId: d.taskId, phase: "rag", durationMs: d.obsMeta.ragMs });
    if (d.obsMeta?.assembleMs !== undefined) d.emit?.({ type: "phase.timing", taskId: d.taskId, phase: "assemble", durationMs: d.obsMeta.assembleMs });

    // Geração RESILIENTE: gera; se um arquivo ficou cortado (cerca de fechamento não veio), re-pede a
    // continuação e costura ao texto acumulado, até o arquivo fechar ou esgotar o teto de tentativas.
    // O usage é ACUMULADO entre as passagens — cada continuação reenvia contexto e tem custo próprio.
    let inputTokens = 0;
    let outputTokens = 0;
    const onUsage = (u: { inputTokens?: number; outputTokens?: number }) => {
      inputTokens += u.inputTokens ?? 0;
      outputTokens += u.outputTokens ?? 0;
    };
    // P3: cada chamada ao provedor vira um span. A PRIMEIRA é a geração principal ("stream"); as seguintes
    // são continuações ("continuation") disparadas por truncamento. durationMs por chamada — onde o tempo vai.
    let streamCall = 0;
    const gen = await resilientGenerate(
      d.messages,
      async (msgs) => {
        const t0 = Date.now();
        try {
          return await this.streamOnce(msgs, onUsage);
        } finally {
          d.emit?.({ type: "phase.timing", taskId: d.taskId, phase: streamCall === 0 ? "stream" : "continuation", durationMs: Date.now() - t0 });
          streamCall++;
        }
      },
      {
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
      // usage parcial acompanha o erro: os tokens até aqui FORAM consumidos — /tokens e o /contexto
      // (host) precisam concordar mesmo quando a geração morre no meio.
      d.post({ type: "stream/error", taskId: d.taskId, message: gen.error, usage });
      d.emit?.({ type: "generation.end", taskId: d.taskId, durationMs: Date.now() - started, model, input, output: gen.full, usage, proposals: 0, error: gen.error });
      return;
    }
    const full = gen.full;
    this.lastGenerated = full; // P1 few-shot vivo: o Controller empilha um turno compacto disto no histórico.
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
      this.pendingValidations.push(this.validateProposal(proposal));
    }

    // Edições de CÉLULA de notebook (.ipynb).
    for (const cb of parseCellBlocks(full)) {
      const proposal = await this.makeCellProposal(cb);
      this.proposals.set(proposal.id, { proposal, results: [], gateOk: true });
      d.post({ type: "stream/proposal", taskId: d.taskId, proposal });
      d.emit?.({ type: "proposal.created", filePath: proposal.filePath, change: "célula", language: proposal.language });
    }

    // Reparo de protocolo (Onda 3): a geração terminou SEM nenhuma proposta aplicável, mas DESCREVEU uma
    // edição de arquivo em cerca comum (o sintoma do print — cerca ```lang + "substitua o conteúdo de X").
    // Dispara UMA reemissão silenciosa como forge-file. detectProseFileEdit é conservador; sem sinal
    // positivo não há chamada extra (custo zero no caminho comum).
    if (this.proposals.size === 0 && !this.controller.signal.aborted && detectProseFileEdit(full)) {
      await this.repairProtocol(full, onUsage);
    }

    // usage REAL (somado entre continuações E a reemissão do reparo, se houve) — alimenta /tokens e a barra.
    const finalUsage = { inputTokens, outputTokens };
    d.emit?.({ type: "generation.end", taskId: d.taskId, durationMs: Date.now() - started, model, input, output: full, usage: finalUsage, proposals: this.proposals.size });
    d.post({ type: "stream/end", taskId: d.taskId, usage: finalUsage });
  }

  // Reparo de protocolo (Onda 3): a geração descreveu uma edição de arquivo em cerca comum, sem bloco
  // forge-file (nenhuma proposta aplicável — o sintoma do print). Faz UMA reemissão SILENCIOSA (não emite
  // stream/text pro chat) pedindo ao modelo os MESMOS arquivos como forge-file. O modelo conhece o caminho
  // certo (ele escreveu o código), então NÃO inferimos path no cliente — nada de sobrescrever arquivo
  // errado por heurística. O que voltar como forge-file entra no pipeline normal (card/validação/gate/
  // apply). Best-effort: erro do provedor ou nenhum bloco reemitido → desiste em silêncio (a prosa original
  // permanece; nada fica pior que antes). Uma única passada — sem laço, sem recursão.
  private async repairProtocol(
    fullText: string,
    onUsage: (u: { inputTokens?: number; outputTokens?: number }) => void
  ): Promise<void> {
    const d = this.deps;
    if (this.controller.signal.aborted) return;
    // Ancora na CAUDA da resposta anterior (não o todo, para não inflar a entrada) + o pedido de reemissão.
    const anchor = fullText.length > CONTINUATION_ANCHOR_CHARS ? fullText.slice(-CONTINUATION_ANCHOR_CHARS) : fullText;
    const convo: ChatMessage[] = [
      ...d.messages,
      { role: "assistant", content: anchor },
      { role: "user", content: buildProtocolReemitPrompt() },
    ];
    let text = "";
    try {
      for await (const chunk of d.provider.createMessage(d.systemPrompt, convo, {
        timeoutMs: d.timeoutMs,
        signal: this.controller.signal,
        extraHeaders: d.extraHeaders,
      })) {
        if (chunk.kind === "text") text += chunk.text;
        else if (chunk.kind === "usage") onUsage({ inputTokens: chunk.inputTokens, outputTokens: chunk.outputTokens });
        else if (chunk.kind === "error") {
          log.warn("Reparo de protocolo: erro do provedor", chunk.message);
          return;
        }
      }
    } catch (err) {
      log.warn("Reparo de protocolo falhou ao reemitir", err);
      return;
    }
    const blocks = parseFileBlocks(text);
    if (blocks.length === 0) {
      // O modelo declinou (o que ele mostrou era ilustrativo, ou insistiu em cerca comum). Desiste em
      // SILÊNCIO: nenhum aviso ao usuário — um falso-positivo da detecção fica 100% invisível.
      log.info("Reparo de protocolo: o modelo não reemitiu blocos forge-file (nada recuperado).");
      return;
    }
    // Só agora — com propostas REAIS a mostrar — avisa o usuário (evita o aviso órfão num falso-positivo).
    d.post({ type: "stream/notice", taskId: d.taskId, level: "info", message: "Converti o código em proposta aplicável (não veio como bloco forge-file)." });
    for (const block of blocks) {
      const proposal = await this.makeProposal(block.path, block.content);
      this.proposals.set(proposal.id, { proposal, results: [], gateOk: true });
      d.post({ type: "stream/proposal", taskId: d.taskId, proposal });
      d.emit?.({ type: "proposal.created", filePath: proposal.filePath, change: proposal.original ? "edição" : "novo", language: proposal.language });
      this.pendingValidations.push(this.validateProposal(proposal));
    }
    log.info(`Reparo de protocolo: ${blocks.length} arquivo(s) recuperado(s) como proposta aplicável.`);
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
    let lastScanLen = 0; // (Modo Projeto) último tamanho em que varremos por blocos fechados — throttle
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
            // Só re-parseia quando o chunk traz uma crase (possível fronteira de cerca) E o texto cresceu
            // um mínimo desde a última varredura (throttle) — evita O(n²) no host em projetos grandes.
            if (d.onFileClosed && chunk.text.includes("`") && text.length - lastScanLen >= STATUS_SCAN_DELTA) {
              lastScanLen = text.length;
              this.notifyClosedBlocks(text);
            }
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

  // Detecta blocos de arquivo que acabaram de FECHAR no texto acumulado e notifica cada caminho uma
  // única vez (Modo Projeto → status "gerado" um a um). `accumulated` é o texto DESTA passagem; num
  // multi-passe (continuação), um arquivo aberto no passe anterior e fechado agora não é visto aqui
  // (a passagem não tem a linha de abertura) — é best-effort: a reconciliação final marca-o "gerado".
  private notifyClosedBlocks(accumulated: string): void {
    const d = this.deps;
    if (!d.onFileClosed) return;
    for (const path of closedBlockPaths(accumulated)) {
      if (!this.closedNotified.has(path)) {
        this.closedNotified.add(path);
        d.onFileClosed(path);
      }
    }
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
    const sqlApplies = !!d.sqlAnalyzer && /\.sql$/i.test(proposal.filePath);
    if (d.validators.length === 0 && !sqlApplies) return;
    d.post({ type: "validation/result", proposalId: proposal.id, results: [], gateOk: true, running: true });
    try {
      const shellResults =
        d.validators.length > 0 ? await d.skillValidator.run(d.validators, proposal.modified, proposal.filePath) : [];
      // Motor SQL in-process (nunca lança — fail-open interno); resultados no mesmo canal do cartão.
      const sqlResults = sqlApplies ? await d.sqlAnalyzer!(proposal.filePath, proposal.modified) : [];
      const results = [...sqlResults, ...shellResults];
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
