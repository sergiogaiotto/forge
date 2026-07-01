import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { RagConfig } from "../config/ManagedConfig";
import { EgressEnforcer } from "../net/EgressEnforcer";
import { log } from "../util/logger";
import { cosine } from "../util/vector";
import { Bm25Index } from "./Bm25Index";
import { chunkFile } from "./chunker";
import { EmbeddingClient } from "./EmbeddingClient";
import { IndexedChunk, RagMode, RetrievalHit } from "./types";

const MAX_CHUNKS = 4000; // teto de segurança de memória/custo de embeddings

// Índice do codebase (RF-041). Recupera trechos relevantes por embeddings
// in-network e, na ausência deles, por BM25 lexical (RF-079). Reindexação
// incremental em mudanças de arquivo. Sem dependência de internet (RNF-016).
export class CodebaseIndex {
  private byFile = new Map<string, IndexedChunk[]>();
  private bm25: Bm25Index | undefined;
  private mode: RagMode = "lexical";
  private ready = false;
  private building = false;
  private capped = false;
  private onChange: (() => void) | undefined;

  constructor(
    private readonly egress: EgressEnforcer,
    private readonly getConfig: () => RagConfig,
    private readonly getWorkspaceRoot: () => string | undefined
  ) {}

  /** Notificado quando o índice fica pronto ou muda de modo (atualiza a UI). */
  setOnChange(fn: () => void): void {
    this.onChange = fn;
  }

  status(): { mode: RagMode; files: number; chunks: number; ready: boolean } {
    return { mode: this.mode, files: this.byFile.size, chunks: this.chunkCount(), ready: this.ready };
  }

  /** Teste de conexão do embedding (como o botão "Testar" do hub interno). */
  async testEmbeddings(): Promise<{ ok: boolean; mode: RagMode; dims?: number; latencyMs?: number; message: string }> {
    const cfg = this.getConfig();
    if (!cfg.enabled) return { ok: true, mode: "lexical", message: "RAG desabilitado." };
    const embedder = this.embedder();
    if (!embedder?.available()) {
      return { ok: true, mode: "lexical", message: "Sem endpoint de embeddings — recuperação lexical (BM25)." };
    }
    const started = Date.now();
    try {
      const [v] = await embedder.embed(["ping de verificação do FORGE"]);
      const dims = v?.length ?? 0;
      return { ok: dims > 0, mode: "embeddings", dims, latencyMs: Date.now() - started, message: `Embeddings OK (${dims} dims).` };
    } catch (err) {
      return { ok: false, mode: "lexical", message: (err as Error).message };
    }
  }

  private chunkCount(): number {
    let n = 0;
    for (const v of this.byFile.values()) n += v.length;
    return n;
  }

  private embedder(): EmbeddingClient | undefined {
    const cfg = this.getConfig();
    if (!cfg.embeddingsUrl) return undefined;
    return new EmbeddingClient(cfg.embeddingsUrl, cfg.embeddingModel, this.egress, cfg.embeddingDimensions);
  }

  /** (Re)constrói o índice inteiro. Não bloqueia a ativação — rode sem await. */
  async build(): Promise<void> {
    const cfg = this.getConfig();
    const root = this.getWorkspaceRoot();
    if (!cfg.enabled || !root) {
      this.ready = true;
      return;
    }
    if (this.building) return;
    this.building = true;
    this.ready = false;
    this.byFile.clear();
    this.capped = false;
    try {
      const files = await this.listFiles(cfg);
      for (const rel of files) {
        if (this.chunkCount() >= MAX_CHUNKS) {
          this.capped = true;
          break;
        }
        await this.indexOneFile(root, rel, cfg);
      }
      await this.rebuildRetrieval();
      if (this.capped) {
        log.warn(`RAG: teto de ${MAX_CHUNKS} trechos atingido; parte do codebase não foi indexada.`);
      }
      log.info(`RAG pronto: ${this.byFile.size} arquivos, ${this.chunkCount()} trechos, modo ${this.mode}.`);
    } catch (err) {
      log.warn("RAG: falha ao indexar codebase", err);
    } finally {
      this.building = false;
      this.ready = true;
      this.onChange?.();
    }
  }

  private async listFiles(cfg: RagConfig): Promise<string[]> {
    const excludeGlob = cfg.exclude.length ? `{${cfg.exclude.join(",")}}` : undefined;
    const seen = new Set<string>();
    for (const inc of cfg.include) {
      const uris = await vscode.workspace.findFiles(inc, excludeGlob, MAX_CHUNKS);
      const root = this.getWorkspaceRoot()!;
      for (const u of uris) {
        if (u.scheme !== "file") continue;
        seen.add(toRel(root, u.fsPath));
      }
    }
    return [...seen];
  }

  private async indexOneFile(root: string, rel: string, cfg: RagConfig): Promise<void> {
    const abs = path.join(root, rel);
    try {
      const stat = await fs.stat(abs);
      if (stat.size > cfg.maxFileSizeKb * 1024) return;
      const content = await fs.readFile(abs, "utf8");
      const chunks = chunkFile(rel, content) as IndexedChunk[];
      if (chunks.length) this.byFile.set(rel, chunks);
    } catch {
      /* arquivo ilegível/binário — ignora */
    }
  }

  /** Recalcula vetores (embeddings) ou o índice BM25 a partir dos trechos atuais. */
  private async rebuildRetrieval(): Promise<void> {
    const all = this.allChunks();
    const embedder = this.embedder();
    if (embedder?.available()) {
      try {
        const vectors = await embedder.embed(all.map((c) => `${c.symbol ?? ""}\n${c.text}`));
        all.forEach((c, i) => (c.vector = vectors[i]));
        this.mode = "embeddings";
        this.bm25 = undefined;
        return;
      } catch (err) {
        log.warn("RAG: embeddings indisponíveis — caindo para BM25 lexical (RF-079).", err);
      }
    }
    this.mode = "lexical";
    this.bm25 = new Bm25Index(all);
  }

  private allChunks(): IndexedChunk[] {
    const out: IndexedChunk[] = [];
    for (const v of this.byFile.values()) out.push(...v);
    return out;
  }

  // ---- atualização incremental ---------------------------------------------

  async updateFile(uri: vscode.Uri): Promise<void> {
    const root = this.getWorkspaceRoot();
    const cfg = this.getConfig();
    if (!cfg.enabled || !root || uri.scheme !== "file" || !this.ready) return;
    const rel = toRel(root, uri.fsPath);
    if (!this.matches(rel, cfg)) return;
    await this.indexOneFile(root, rel, cfg);
    await this.rebuildRetrieval();
    this.onChange?.();
  }

  async removeFile(uri: vscode.Uri): Promise<void> {
    const root = this.getWorkspaceRoot();
    if (!root) return;
    const rel = toRel(root, uri.fsPath);
    if (this.byFile.delete(rel)) {
      await this.rebuildRetrieval();
      this.onChange?.();
    }
  }

  private matches(rel: string, cfg: RagConfig): boolean {
    const ext = path.extname(rel).toLowerCase();
    return cfg.include.some((g) => g.toLowerCase().endsWith(ext)) && !cfg.exclude.some((g) => rel.includes(g.replace(/\*\*\//g, "").replace(/\/\*\*/g, "")));
  }

  // ---- inspeção read-only (visualizador de índice) --------------------------

  /** Teto de chunks e se o índice foi truncado por ele (para o visualizador). O `capped` é reconciliado
   *  com a contagem atual — não fica "preso" em true depois que arquivos são removidos e o índice volta
   *  abaixo do teto. */
  limits(): { maxChunks: number; capped: boolean } {
    return { maxChunks: MAX_CHUNKS, capped: this.capped && this.chunkCount() >= MAX_CHUNKS };
  }

  /** Lista os arquivos indexados (relPath, linguagem, nº de chunks), ordenados. Sem reprocessar. */
  listIndexedFiles(): { relPath: string; language: string; chunks: number }[] {
    return [...this.byFile.entries()]
      .map(([relPath, chunks]) => ({ relPath, language: chunks[0]?.language ?? "?", chunks: chunks.length }))
      .sort((a, b) => a.relPath.localeCompare(b.relPath));
  }

  /** Chunks de UM arquivo indexado (id, linhas, símbolo, se tem vetor, e o texto). Sem reprocessar. */
  fileChunks(relPath: string): { id: string; startLine: number; endLine: number; symbol?: string; hasVector: boolean; text: string }[] {
    return (this.byFile.get(relPath) ?? []).map((c) => ({
      id: c.id,
      startLine: c.startLine,
      endLine: c.endLine,
      symbol: c.symbol,
      hasVector: !!c.vector,
      text: c.text,
    }));
  }

  // ---- recuperação ----------------------------------------------------------

  async retrieve(query: string, k: number): Promise<RetrievalHit[]> {
    if (!this.ready || this.chunkCount() === 0) return [];
    if (this.mode === "embeddings") {
      const embedder = this.embedder();
      if (embedder?.available()) {
        try {
          const [qv] = await embedder.embed([query]);
          const hits = this.allChunks()
            .filter((c) => c.vector)
            .map((c) => ({ chunk: c, score: cosine(qv, c.vector!) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, k);
          return hits;
        } catch (err) {
          log.warn("RAG: falha na busca por embeddings — usando BM25.", err);
          if (!this.bm25) this.bm25 = new Bm25Index(this.allChunks());
        }
      }
    }
    if (!this.bm25) this.bm25 = new Bm25Index(this.allChunks());
    return this.bm25.query(query, k);
  }
}

function toRel(root: string, fsPath: string): string {
  return path.relative(root, fsPath).split(path.sep).join("/");
}
