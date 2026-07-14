import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { RagConfig } from "../config/ManagedConfig";
import { hostT } from "../i18n";
import { EgressEnforcer } from "../net/EgressEnforcer";
import { log } from "../util/logger";
import { redactSecrets } from "../util/redact";
import { cosine } from "../util/vector";
import { Bm25Index } from "./Bm25Index";
import { chunkFile } from "./chunker";
import { EmbeddingClient } from "./EmbeddingClient";
import { canReuse, FileMeta, parseSnapshot, redactChunks, serializeSnapshot, snapshotFileName, vectorsCompatible } from "./indexPersistence";
import { IndexedChunk, RagMode, RetrievalHit } from "./types";

const MAX_CHUNKS = 4000; // teto de segurança de memória/custo de embeddings

// Índice do codebase (RF-041). Recupera trechos relevantes por embeddings
// in-network e, na ausência deles, por BM25 lexical (RF-079). Reindexação
// incremental em mudanças de arquivo. Persistido no globalStorage (Fase 3): o cold-start reconcilia
// por mtime e só re-embeda o que mudou. Sem dependência de internet (RNF-016).
export class CodebaseIndex {
  private byFile = new Map<string, IndexedChunk[]>();
  private fileMeta = new Map<string, FileMeta>(); // mtime+size por arquivo (para o snapshot)
  private bm25: Bm25Index | undefined;
  private mode: RagMode = "lexical";
  private ready = false;
  private building = false;
  private capped = false;
  private cappedNotified = false;
  private onChange: (() => void) | undefined;

  constructor(
    private readonly egress: EgressEnforcer,
    private readonly getConfig: () => RagConfig,
    private readonly getWorkspaceRoot: () => string | undefined,
    // Diretório de persistência (globalStorage). undefined = sem persistência (comportamento antigo).
    private readonly getStorageDir: () => string | undefined = () => undefined,
    // Aviso ao usuário quando o teto de chunks é atingido (antes só ia para o log). Opcional.
    private readonly notify: (msg: string) => void = () => undefined
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
    if (!cfg.enabled) return { ok: true, mode: "lexical", message: hostT("rag.test.disabled") };
    const embedder = this.embedder();
    if (!embedder?.available()) {
      return { ok: true, mode: "lexical", message: hostT("rag.test.lexical") };
    }
    const started = Date.now();
    try {
      const [v] = await embedder.embed(["ping de verificação do FORGE"]);
      const dims = v?.length ?? 0;
      return { ok: dims > 0, mode: "embeddings", dims, latencyMs: Date.now() - started, message: hostT("rag.test.ok", { dims }) };
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
    this.fileMeta.clear();
    this.capped = false;
    this.cappedNotified = false;
    try {
      // Snapshot persistido: reusa os chunks (com vetores) dos arquivos que NÃO mudaram; só re-indexa
      // (e depois re-embeda) os que mudaram/são novos. Se o modelo de embeddings mudou, os vetores são
      // incompatíveis e tudo é re-embedado (reconciliação por conteúdo continua valendo).
      void this.pruneOrphanSnapshots(root); // remove snapshots de workspaces sumidos (best-effort, não bloqueia)
      const snap = await this.loadSnapshot(root);
      const vecOk = snap ? vectorsCompatible(snap, cfg.embeddingModel) : false;
      let reused = 0;
      const files = await this.listFiles(cfg);
      for (const rel of files) {
        if (this.chunkCount() >= MAX_CHUNKS) {
          this.capped = true;
          break;
        }
        const cur = await this.statMeta(root, rel);
        const persisted = snap?.files[rel];
        if (cur && vecOk && canReuse(persisted, cur)) {
          this.byFile.set(rel, persisted!.chunks);
          this.fileMeta.set(rel, cur);
          reused++;
        } else {
          await this.indexOneFile(root, rel, cfg);
        }
      }
      await this.rebuildRetrieval(); // embeda só os chunks SEM vetor (os reusados já têm)
      if (this.capped) this.warnCapped();
      // NÃO sobrescreve um snapshot de embeddings bom quando caímos para lexical por FALHA transitória
      // do endpoint (senão a próxima sessão perde o cache e re-embeda tudo). Achado da revisão adversarial.
      if (!(this.lastEmbedFailed && snap?.mode === "embeddings")) {
        await this.persist(root, cfg);
      } else {
        log.warn("RAG: embeddings falharam nesta sessão — preservando o snapshot anterior (não sobrescreve com lexical).");
      }
      log.info(`RAG pronto: ${this.byFile.size} arquivos (${reused} reusados do cache), ${this.chunkCount()} trechos, modo ${this.mode}.`);
    } catch (err) {
      log.warn("RAG: falha ao indexar codebase", err);
    } finally {
      this.building = false;
      this.ready = true;
      this.onChange?.();
    }
  }

  private warnCapped(): void {
    const msg = hostT("rag.capped", { max: MAX_CHUNKS });
    log.warn(msg);
    if (!this.cappedNotified) {
      this.cappedNotified = true;
      this.notify(msg); // aviso VISÍVEL ao dev (antes era só log — o "trunca em silêncio" da auditoria)
    }
  }

  // mtime+size de um arquivo (para reconciliar com o snapshot). undefined se ilegível.
  private async statMeta(root: string, rel: string): Promise<FileMeta | undefined> {
    try {
      const st = await fs.stat(path.join(root, rel));
      return { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      return undefined;
    }
  }

  // ---- persistência ---------------------------------------------------------

  private snapshotPath(root: string): string | undefined {
    const dir = this.getStorageDir();
    return dir ? path.join(dir, snapshotFileName(root)) : undefined;
  }

  private async loadSnapshot(root: string) {
    const p = this.snapshotPath(root);
    if (!p) return null;
    try {
      const snap = parseSnapshot(await fs.readFile(p, "utf8"));
      // Snapshot de OUTRO workspace no mesmo arquivo (colisão de hash improvável) → descarta.
      return snap && snap.workspaceRoot === root ? snap : null;
    } catch {
      return null; // ausente/corrompido → rebuild do zero
    }
  }

  private async persist(root: string, cfg: RagConfig): Promise<void> {
    const p = this.snapshotPath(root);
    if (!p) return;
    try {
      const files = new Map<string, { meta: FileMeta; chunks: IndexedChunk[] }>();
      for (const [rel, chunks] of this.byFile) {
        const meta = this.fileMeta.get(rel);
        if (meta) files.set(rel, { meta, chunks });
      }
      // dims REAIS do vetor (não o valor da config, que é 0 = "padrão do modelo") — para observabilidade
      // do snapshot; a correção de drift real é a checagem de homogeneidade no rebuildRetrieval.
      const realDims = this.allChunks().find((c) => c.vector && c.vector.length > 0)?.vector?.length ?? 0;
      const json = serializeSnapshot({
        workspaceRoot: root,
        embeddingModel: this.mode === "embeddings" ? cfg.embeddingModel : "",
        embeddingDims: this.mode === "embeddings" ? realDims : 0,
        mode: this.mode,
        files,
      });
      await fs.mkdir(path.dirname(p), { recursive: true });
      // Escrita ATÔMICA: grava num temp e renomeia por cima. Um crash no meio do writeFile não destrói
      // mais o snapshot bom anterior (rename é atômico no mesmo FS). Achado da revisão adversarial.
      const tmp = `${p}.tmp`;
      await fs.writeFile(tmp, json, "utf8");
      await fs.rename(tmp, p);
    } catch (err) {
      log.warn("RAG: falha ao persistir o índice (segue em memória).", err);
    }
  }

  // Remove snapshots órfãos (workspaces que não são o atual e cujo arquivo é antigo) do globalStorage —
  // sem isto, cada projeto já aberto deixa ~MBs de snapshot para sempre. Best-effort, age-based: só
  // apaga arquivos com mtime > 60 dias (o snapshot do workspace ATIVO é reescrito todo build, mtime
  // sempre fresco, então nunca é apagado). Achado da revisão adversarial.
  private async pruneOrphanSnapshots(root: string): Promise<void> {
    const dir = this.getStorageDir();
    if (!dir) return;
    const keep = snapshotFileName(root);
    const cutoff = Date.now() - 60 * 24 * 60 * 60 * 1000;
    try {
      for (const name of await fs.readdir(dir)) {
        if (name === keep || !/^rag-index-[0-9a-f]{16}\.json$/.test(name)) continue;
        try {
          const st = await fs.stat(path.join(dir, name));
          if (st.mtimeMs < cutoff) await fs.rm(path.join(dir, name), { force: true });
        } catch {
          /* corrida/permissão — ignora */
        }
      }
    } catch {
      /* dir ausente — nada a podar */
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
    // Ordem DETERMINÍSTICA: o vscode.workspace.findFiles não garante ordem estável entre sessões, e o
    // teto MAX_CHUNKS trunca a lista — sem ordenar, um repo capado re-embedaria um subconjunto diferente
    // a cada sessão (revisão adversarial). Ordenado, o corte é sempre o mesmo.
    return [...seen].sort();
  }

  private async indexOneFile(root: string, rel: string, cfg: RagConfig): Promise<void> {
    // Teto de segurança de memória/custo de embeddings: um arquivo NOVO não entra se o índice já bateu o teto.
    // O build() já guarda (break no laço), mas a via INCREMENTAL (updateFile via watcher) não guardava — durante
    // uma geração do Modo Projeto, o onDidCreate por arquivo gerado crescia byFile SEM limite, passando de
    // MAX_CHUNKS (achado do survey). Re-indexar um arquivo JÁ presente (onDidChange) é permitido: substitui os
    // próprios chunks (não cresce o total líquido; um arquivo que encolheu pode até liberar espaço).
    if (!this.byFile.has(rel) && this.chunkCount() >= MAX_CHUNKS) {
      if (!this.capped) {
        this.capped = true;
        this.warnCapped(); // avisa 1× na TRANSIÇÃO p/ capped, não por arquivo pulado (evita spam de log numa geração)
      }
      return;
    }
    const abs = path.join(root, rel);
    try {
      const stat = await fs.stat(abs);
      if (stat.size > cfg.maxFileSizeKb * 1024) return;
      const content = await fs.readFile(abs, "utf8");
      const chunks = chunkFile(rel, content) as IndexedChunk[]; // chunks NOVOS não têm vetor ainda
      // SEGURANÇA (exfil RAG): redige segredos (texto E símbolo) NA ORIGEM. Todo consumidor lê de byFile
      // — o embed (endpoint EXTERNO de embeddings, fora do gateway que redige) e o snapshot em disco
      // (globalStorage, texto plano) contornavam a redação do prompt. Este único ponto fecha as DUAS vias.
      // redact() é puro/determinístico e preserva símbolos/identificadores/hosts, então a qualidade de
      // recuperação (cosseno/BM25) fica intacta — segredos são tokens opacos sem valor semântico p/ busca.
      const redacted = redactChunks(chunks);
      if (redacted.length) {
        this.byFile.set(rel, redacted);
        this.fileMeta.set(rel, { mtimeMs: stat.mtimeMs, size: stat.size });
      }
    } catch {
      /* arquivo ilegível/binário — ignora */
    }
  }

  private lastEmbedFailed = false; // rebuildRetrieval caiu para lexical por FALHA de embed (não por ausência de endpoint)?

  /** Recalcula vetores (embeddings) ou o índice BM25 a partir dos trechos atuais. O embedding é
   *  INCREMENTAL: só os chunks SEM vetor são embedados (os reusados do snapshot já têm) — evita
   *  re-embedar o codebase inteiro a cada build/save (o custo recorrente que a auditoria apontou). */
  private async rebuildRetrieval(): Promise<void> {
    const all = this.allChunks();
    const embedder = this.embedder();
    this.lastEmbedFailed = false;
    if (embedder?.available()) {
      try {
        let missing = all.filter((c) => !c.vector || c.vector.length === 0);
        if (missing.length > 0) {
          const vectors = await embedder.embed(missing.map((c) => `${c.symbol ?? ""}\n${c.text}`));
          missing.forEach((c, i) => (c.vector = vectors[i]));
        }
        // Homogeneidade de dimensão: se algum vetor REUSADO do snapshot tem comprimento diferente dos
        // recém-embedados, o modelo/deploy de embeddings mudou por trás do mesmo nome — re-embeda TUDO
        // (senão a mistura de dims dá score espúrio no cosseno). Achado da revisão adversarial.
        const fresh = missing.find((c) => c.vector && c.vector.length > 0);
        const dim = fresh?.vector?.length ?? all.find((c) => c.vector)?.vector?.length;
        if (dim && all.some((c) => c.vector && c.vector.length !== dim)) {
          log.warn("RAG: dimensão de embedding inconsistente entre o cache e o endpoint — re-embedando tudo.");
          for (const c of all) c.vector = undefined;
          const revectors = await embedder.embed(all.map((c) => `${c.symbol ?? ""}\n${c.text}`));
          all.forEach((c, i) => (c.vector = revectors[i]));
        }
        this.mode = "embeddings";
        this.bm25 = undefined;
        return;
      } catch (err) {
        log.warn("RAG: embeddings indisponíveis — caindo para BM25 lexical (RF-079).", err);
        this.lastEmbedFailed = true; // FALHA transitória — o build não deve sobrescrever um snapshot bom
        for (const c of all) c.vector = undefined; // não mistura modelos/dims no modo lexical
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
      this.fileMeta.delete(rel);
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
    // SEGURANÇA (exfil RAG, 3ª via): redige a QUERY antes de qualquer uso. O embed a manda ao endpoint
    // EXTERNO de embeddings — a MESMA via que o indexOneFile já fecha para os chunks (redactChunks); a query
    // era o vetor que faltava (a mensagem do dev pode trazer erro colado/connection-string/código com segredo).
    // Como o índice (vetores/BM25) é montado sobre chunks REDIGIDOS, buscar em espaço redigido ALINHA a
    // qualidade (redactSecrets preserva símbolos/identificadores/hosts; segredo é token opaco sem valor de busca).
    const q = redactSecrets(query);
    if (this.mode === "embeddings") {
      const embedder = this.embedder();
      if (embedder?.available()) {
        try {
          const [qv] = await embedder.embed([q]);
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
    return this.bm25.query(q, k); // q redigido: alinha com o índice (chunks redigidos) e não vaza no fallback
  }
}

function toRel(root: string, fsPath: string): string {
  return path.relative(root, fsPath).split(path.sep).join("/");
}
