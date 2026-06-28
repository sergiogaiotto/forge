import { SkillMeta } from "./types";

export interface SelectorConfig {
  retrievalThreshold: number; // RF-037
  topK: number;
  activationThreshold: number; // pontuação léxica mínima para auto-ativar o corpo de uma skill
  maxActivations: number;
}

const STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "and", "or", "for", "with", "in", "on", "use", "using", "when", "whenever",
  "o", "a", "os", "as", "de", "do", "da", "para", "com", "em", "use", "quando", "que", "um", "uma", "e",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9á-úà-ùâ-û_\- ]/gi, " ")
    .split(/[\s\-_]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

// Relevância léxica (fallback do RF-079 quando não há embeddings disponíveis). Pontua
// o quão bem o name+description de uma skill correspondem à consulta do usuário.
export function lexicalScore(query: string, skill: SkillMeta): number {
  const q = new Set(tokenize(query));
  if (q.size === 0) return 0;
  const nameTokens = tokenize(skill.name);
  const descTokens = tokenize(skill.description);
  let score = 0;
  for (const t of nameTokens) if (q.has(t)) score += 2; // correspondências no name pesam mais
  for (const t of descTokens) if (q.has(t)) score += 1;
  // Normaliza pelo tamanho da consulta para que consultas longas não dominem.
  return score / Math.sqrt(q.size);
}

export class SkillSelector {
  constructor(private readonly cfg: SelectorConfig) {}

  // Nível 1 — descoberta: quais name+description de skills entram no system prompt.
  selectForDiscovery(all: SkillMeta[], query?: string): SkillMeta[] {
    const enabled = all.filter((s) => s.enabled);
    if (enabled.length <= this.cfg.retrievalThreshold || !query) {
      return enabled;
    }
    return [...enabled]
      .map((s) => ({ s, score: lexicalScore(query, s) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, this.cfg.topK)
      .map((x) => x.s);
  }

  // Nível 2 — ativação: quais corpos de skill carregar para esta consulta (RF-033).
  selectForActivation(discovery: SkillMeta[], query: string): SkillMeta[] {
    return discovery
      .map((s) => ({ s, score: lexicalScore(query, s) }))
      .filter((x) => x.score >= this.cfg.activationThreshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, this.cfg.maxActivations)
      .map((x) => x.s);
  }
}

export const DEFAULT_SELECTOR_CONFIG: SelectorConfig = {
  retrievalThreshold: 15,
  topK: 8,
  activationThreshold: 1.0,
  maxActivations: 3,
};
