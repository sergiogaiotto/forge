// Persistência do índice RAG (Fase 3). Antes, o índice vivia só em memória: toda ativação re-lia e
// RE-EMBEDAVA o codebase inteiro (custo de embeddings recorrente + latência no 1º uso), e o teto de
// 4000 chunks truncava em silêncio. Aqui: serializa o índice (com os vetores) num snapshot em disco
// (globalStorage), e no cold-start reconcilia por mtime+size — só os arquivos que MUDARAM são
// re-indexados/re-embedados; o resto reusa os vetores persistidos. PURO/testável (I/O fica no
// CodebaseIndex).
import { createHash } from "node:crypto";
import { IndexedChunk } from "./types";

export const SNAPSHOT_VERSION = 2;

export interface FileMeta {
  mtimeMs: number;
  size: number;
}

export interface PersistedFile extends FileMeta {
  chunks: IndexedChunk[];
}

export interface IndexSnapshot {
  version: number;
  workspaceRoot: string;
  embeddingModel: string; // "" quando lexical
  embeddingDims: number; // 0 quando lexical
  mode: "embeddings" | "lexical";
  files: Record<string, PersistedFile>;
}

// Nome de arquivo do snapshot por workspace (hash do root — evita colisão entre projetos e caracteres
// inválidos de caminho).
export function snapshotFileName(workspaceRoot: string): string {
  const h = createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
  return `rag-index-${h}.json`;
}

// Vetor Float32 → base64 (compacto: 4 bytes/float vs ~15 chars/float em JSON). undefined quando o chunk
// não tem vetor (modo lexical).
function encodeVector(v: number[] | undefined): string | undefined {
  if (!v || v.length === 0) return undefined;
  const buf = Buffer.from(Float32Array.from(v).buffer);
  return buf.toString("base64");
}

function decodeVector(b64: string | undefined): number[] | undefined {
  if (!b64) return undefined;
  const buf = Buffer.from(b64, "base64");
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
  return Array.from(f32);
}

// Serializa o índice num snapshot JSON-string. Vetores viram base64; o resto do chunk é preservado.
export function serializeSnapshot(snap: {
  workspaceRoot: string;
  embeddingModel: string;
  embeddingDims: number;
  mode: "embeddings" | "lexical";
  files: Map<string, { meta: FileMeta; chunks: IndexedChunk[] }>;
}): string {
  const files: Record<string, unknown> = {};
  for (const [rel, { meta, chunks }] of snap.files) {
    files[rel] = {
      mtimeMs: meta.mtimeMs,
      size: meta.size,
      chunks: chunks.map((c) => ({ ...c, vector: undefined, v: encodeVector(c.vector) })),
    };
  }
  return JSON.stringify({
    version: SNAPSHOT_VERSION,
    workspaceRoot: snap.workspaceRoot,
    embeddingModel: snap.embeddingModel,
    embeddingDims: snap.embeddingDims,
    mode: snap.mode,
    files,
  });
}

// Desserializa; retorna null se a versão/estrutura não bate (força rebuild). Reidrata os vetores.
export function parseSnapshot(json: string): IndexSnapshot | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== SNAPSHOT_VERSION || typeof r.files !== "object" || r.files === null) return null;
  const files: Record<string, PersistedFile> = {};
  for (const [rel, val] of Object.entries(r.files as Record<string, unknown>)) {
    const v = val as Record<string, unknown>;
    if (typeof v.mtimeMs !== "number" || typeof v.size !== "number" || !Array.isArray(v.chunks)) continue;
    const chunks = (v.chunks as Record<string, unknown>[]).map((c) => {
      const chunk = { ...c } as Record<string, unknown> & { v?: string };
      const vector = decodeVector(chunk.v);
      delete chunk.v;
      return { ...chunk, vector } as unknown as IndexedChunk;
    });
    files[rel] = { mtimeMs: v.mtimeMs, size: v.size, chunks };
  }
  return {
    version: SNAPSHOT_VERSION,
    workspaceRoot: typeof r.workspaceRoot === "string" ? r.workspaceRoot : "",
    embeddingModel: typeof r.embeddingModel === "string" ? r.embeddingModel : "",
    embeddingDims: typeof r.embeddingDims === "number" ? r.embeddingDims : 0,
    mode: r.mode === "embeddings" ? "embeddings" : "lexical",
    files,
  };
}

// Um arquivo persistido pode ser REUSADO quando existe no snapshot e mtime+size batem com o disco atual.
export function canReuse(persisted: PersistedFile | undefined, current: FileMeta | undefined): boolean {
  if (!persisted || !current) return false;
  return persisted.mtimeMs === current.mtimeMs && persisted.size === current.size;
}

// Os vetores persistidos servem para o modelo/dims ATUAIS? (se o admin trocou o modelo de embeddings,
// os vetores antigos são incompatíveis — descarta e re-embeda tudo.)
export function vectorsCompatible(snap: IndexSnapshot, model: string, dims: number): boolean {
  return snap.mode === "embeddings" && snap.embeddingModel === model && snap.embeddingDims === dims;
}
