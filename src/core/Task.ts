import * as fs from "node:fs/promises";
import * as path from "node:path";
import { LLMProvider } from "../api/types";
import { ChatMessage } from "../api/types";
import { gatePassed, SkillValidator } from "../skills/SkillValidator";
import { SkillValidatorSpec } from "../skills/types";
import { DiffProposal, ExtToWebview, ValidatorResult } from "../shared/protocol";
import { parseCellBlocks, parseNotebookCells } from "../util/cellBlocks";
import { parseFileBlocks } from "../util/fileBlocks";
import { log } from "../util/logger";

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
    d.post({ type: "stream/start", taskId: d.taskId });
    for (const s of d.activatedSkillNames) d.post({ type: "stream/skill", taskId: d.taskId, skill: s });

    let full = "";
    try {
      for await (const chunk of d.provider.createMessage(d.systemPrompt, d.messages, {
        timeoutMs: d.timeoutMs,
        signal: this.controller.signal,
        extraHeaders: d.extraHeaders,
      })) {
        switch (chunk.kind) {
          case "reasoning":
            d.post({ type: "stream/reasoning", taskId: d.taskId, delta: chunk.text });
            break;
          case "text":
            full += chunk.text;
            d.post({ type: "stream/text", taskId: d.taskId, delta: chunk.text });
            break;
          case "error":
            d.post({ type: "stream/error", taskId: d.taskId, message: chunk.message });
            return;
          case "usage":
          case "tool_call":
            break;
        }
      }
    } catch (err) {
      d.post({ type: "stream/error", taskId: d.taskId, message: (err as Error).message });
      return;
    }

    // Faz o parse das edições de arquivo propostas e transforma cada uma em um diff revisável.
    const blocks = parseFileBlocks(full);
    for (const block of blocks) {
      const proposal = await this.makeProposal(block.path, block.content);
      this.proposals.set(proposal.id, { proposal, results: [], gateOk: true });
      d.post({ type: "stream/proposal", taskId: d.taskId, proposal });
      void this.validateProposal(proposal);
    }

    // Edições de CÉLULA de notebook (.ipynb).
    for (const cb of parseCellBlocks(full)) {
      const proposal = await this.makeCellProposal(cb);
      this.proposals.set(proposal.id, { proposal, results: [], gateOk: true });
      d.post({ type: "stream/proposal", taskId: d.taskId, proposal });
    }

    d.post({ type: "stream/end", taskId: d.taskId });
  }

  private async makeCellProposal(cb: import("../util/cellBlocks").CellBlock): Promise<DiffProposal> {
    const d = this.deps;
    let original = "";
    if (cb.op === "replace" && cb.index !== undefined && d.workspaceRoot) {
      try {
        const content = await fs.readFile(path.join(d.workspaceRoot, cb.path), "utf8");
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
    if (d.workspaceRoot) {
      try {
        original = await fs.readFile(path.join(d.workspaceRoot, relPath), "utf8");
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
    } catch (err) {
      log.warn("Validação falhou", err);
      d.post({ type: "validation/result", proposalId: proposal.id, results: [], gateOk: true, running: false });
    }
  }
}
