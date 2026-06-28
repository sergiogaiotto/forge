import { ChatMessage } from "../api/types";
import { SkillMeta } from "./types";

export interface AssembleInput {
  basePrompt: string;
  discoverySkills: SkillMeta[]; // nível 1: name + description
  activatedSkills: { meta: SkillMeta; body: string }[]; // nível 2: corpo completo
  retrievedContext: string; // contexto de RAG / arquivo aberto
  history: ChatMessage[];
  query: string;
  tokenBudget?: number; // orçamento aproximado de chars para o system prompt montado
}

export interface AssembleOutput {
  systemPrompt: string;
  messages: ChatMessage[];
  activatedSkillNames: string[];
}

// RF-040: monta na ordem base + skills(discovery) → contexto recuperado →
// corpos das skills ativadas → histórico → query. Discovery/contexto/corpos ficam no
// system prompt; o histórico e a query formam a lista de mensagens.
export class ContextAssembler {
  assemble(input: AssembleInput): AssembleOutput {
    const parts: string[] = [input.basePrompt];

    if (input.discoverySkills.length > 0) {
      const lines = input.discoverySkills
        .map((s) => `- ${s.name}: ${s.description.replace(/\s+/g, " ").trim()}`)
        .join("\n");
      parts.push(`# Skills disponíveis (discovery)\n${lines}`);
    }

    if (input.retrievedContext.trim().length > 0) {
      parts.push(`# Contexto do código recuperado\n${input.retrievedContext.trim()}`);
    }

    if (input.activatedSkills.length > 0) {
      for (const { meta, body } of input.activatedSkills) {
        parts.push(`# Skill ativada: ${meta.name}\n${body.trim()}`);
      }
    }

    let systemPrompt = parts.join("\n\n");
    if (input.tokenBudget && systemPrompt.length > input.tokenBudget * 4) {
      // Compactação grosseira por orçamento de chars: mantém base + discovery + trunca o resto.
      systemPrompt = systemPrompt.slice(0, input.tokenBudget * 4) + "\n\n[contexto truncado por orçamento]";
    }

    const messages: ChatMessage[] = [...input.history, { role: "user", content: input.query }];

    return {
      systemPrompt,
      messages,
      activatedSkillNames: input.activatedSkills.map((a) => a.meta.name),
    };
  }
}
