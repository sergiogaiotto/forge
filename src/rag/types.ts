// Modelos de dados da indexação do codebase (RAG).

export interface Chunk {
  id: string; // `${relPath}#${startLine}`
  relPath: string;
  language: string;
  symbol?: string; // declaração mais próxima (def/class/SELECT/heading…)
  startLine: number; // 1-based
  endLine: number;
  text: string;
}

export interface IndexedChunk extends Chunk {
  vector?: number[]; // presente no modo embeddings
  tokens?: string[]; // presente no modo lexical (BM25)
}

export interface RetrievalHit {
  chunk: Chunk;
  score: number;
}

export type RagMode = "embeddings" | "lexical";
