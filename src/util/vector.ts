// Utilitários vetoriais para a recuperação semântica (RAG).

/** Similaridade do cosseno entre dois vetores de mesma dimensão. */
export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Tokenização compartilhada: minúsculas, quebra por não-alfanuméricos e
 *  separação de camelCase/snake_case para casar identificadores de código. */
export function tokenizeCode(text: string): string[] {
  const out: string[] = [];
  const rough = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // camelCase → camel Case
    .toLowerCase()
    .split(/[^a-z0-9_áàâãéêíóôõúç]+/i);
  for (const piece of rough) {
    for (const t of piece.split("_")) {
      if (t.length >= 2) out.push(t);
    }
  }
  return out;
}
