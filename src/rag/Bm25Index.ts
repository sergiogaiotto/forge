import { Chunk, RetrievalHit } from "./types";
import { tokenizeCode } from "../util/vector";

interface Doc {
  chunk: Chunk;
  tf: Map<string, number>;
  length: number;
}

// Recuperação lexical BM25 — usada quando não há endpoint de embeddings
// in-network (RF-079). Determinística e 100% offline.
export class Bm25Index {
  private readonly docs: Doc[] = [];
  private readonly df = new Map<string, number>();
  private avgdl = 0;
  private readonly k1 = 1.5;
  private readonly b = 0.75;

  constructor(chunks: Chunk[]) {
    let total = 0;
    for (const chunk of chunks) {
      const tokens = tokenizeCode(`${chunk.symbol ?? ""} ${chunk.text}`);
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.docs.push({ chunk, tf, length: tokens.length });
      total += tokens.length;
    }
    this.avgdl = this.docs.length ? total / this.docs.length : 0;
  }

  get size(): number {
    return this.docs.length;
  }

  private idf(term: string): number {
    const n = this.docs.length;
    const df = this.df.get(term) ?? 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  query(text: string, k: number): RetrievalHit[] {
    const qTerms = [...new Set(tokenizeCode(text))];
    if (qTerms.length === 0 || this.docs.length === 0) return [];
    const scored: RetrievalHit[] = [];
    for (const doc of this.docs) {
      let score = 0;
      for (const term of qTerms) {
        const tf = doc.tf.get(term);
        if (!tf) continue;
        const idf = this.idf(term);
        const denom = tf + this.k1 * (1 - this.b + (this.b * doc.length) / (this.avgdl || 1));
        score += idf * ((tf * (this.k1 + 1)) / denom);
      }
      if (score > 0) scored.push({ chunk: doc.chunk, score });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, k);
  }
}
