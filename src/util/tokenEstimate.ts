// Estimativa de tokens SEM tokenizer real (que dependeria do modelo). É uma heurística por densidade,
// melhor que o "chars/4" cego usado hoje no orçamento de contexto: código tem densidade de token
// diferente de prosa (símbolos, indentação, identificadores longos). A estimativa tende a ser
// LEVEMENTE conservadora (superestimar) de propósito — subestimar custaria um HTTP 400 do gateway por
// estourar a janela; superestimar só deixa um pouco de folga. O orçamento aplica margem por cima disso.

// Combina duas heurísticas e usa a MAIOR (mais conservadora):
//  - chars/4: bom para prosa em inglês/pt; subestima código denso em símbolos.
//  - "peças" (palavras + símbolos individuais) * 0.95: captura a densidade de código/JSON/markup,
//    onde cada símbolo (parênteses, dois-pontos, vírgulas) tende a virar um token.
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const byChars = text.length / 4;
  const pieces = text.match(/[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g);
  const byPieces = (pieces ? pieces.length : 0) * 0.95;
  return Math.ceil(Math.max(byChars, byPieces));
}

// Soma estimada de uma lista de strings (ex.: mensagens já formatadas), com um pequeno overhead por
// item para o envelope de role/formatação que o servidor adiciona a cada mensagem.
export function estimateTokensOf(parts: string[], perItemOverhead = 4): number {
  return parts.reduce((sum, p) => sum + estimateTokens(p) + perItemOverhead, 0);
}
