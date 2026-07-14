import { ChatMessage } from "../api/types";
import { estimateTokens } from "../util/tokenEstimate";
import { SkillMeta } from "./types";

export interface AssembleInput {
  basePrompt: string;
  projectProfile?: string; // perfil do projeto (.forge/project.md) — convenções/regras do time
  discoverySkills: SkillMeta[]; // nível 1: name + description
  activatedSkills: { meta: SkillMeta; body: string }[]; // nível 2: corpo completo
  retrievedContext: string; // contexto de RAG / arquivo aberto
  history: ChatMessage[];
  query: string;
  inputBudgetTokens?: number; // orçamento de ENTRADA em TOKENS (system + history + query)
}

export interface AssembleOutput {
  systemPrompt: string;
  messages: ChatMessage[];
  activatedSkillNames: string[];
}

// Trunca um texto garantindo estimateTokens(resultado) <= maxTokens, cortando na última quebra de linha
// para não partir uma função/bloco no meio. Usa a MESMA medição (estimateTokens) do orçamento em vez do
// "chars*4" cego: código denso tem menos chars/token, então chars*4 devolvia um texto com MUITO mais que
// maxTokens tokens e estourava o inputBudget → HTTP 400 do gateway (o footgun que o #203 fechou; achado do
// survey pós-#217). Busca binária pelo maior prefixo dentro do teto (estimateTokens é não-decrescente no
// comprimento — mede a densidade real em vez de assumi-la). Prosa (≈ chars/4) sai igual ao anterior.
function truncateToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return "";
  if (estimateTokens(text) <= maxTokens) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2); // ceil de (lo+hi)/2 → progride (mid > lo)
    if (estimateTokens(text.slice(0, mid)) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  const cut = text.slice(0, lo);
  const nl = cut.lastIndexOf("\n");
  return nl > lo * 0.5 ? cut.slice(0, nl) : cut; // só recua até a linha se não perder metade
}

// Inclui o histórico das mensagens MAIS RECENTES até caber no orçamento (em tokens). Resolve a lacuna
// de o histórico antes ser injetado inteiro, sem medição, podendo estourar a janela em sessões longas.
function historyWithinBudget(history: ChatMessage[], budgetTokens: number): ChatMessage[] {
  const out: ChatMessage[] = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const cost = estimateTokens(history[i].content) + 4;
    if (used + cost > budgetTokens) break;
    out.unshift(history[i]);
    used += cost;
  }
  // Garante ao menos o turno MAIS RECENTE (truncado) quando ele sozinho excede o orçamento — sem isto
  // o modelo perderia toda a última troca (ex.: usuário colou um stacktrace grande) e receberia só a query.
  if (out.length === 0 && history.length > 0 && budgetTokens > 0) {
    const last = history[history.length - 1];
    out.push({ ...last, content: truncateToTokens(last.content, budgetTokens) });
  }
  return out;
}

// RF-040 (evoluído): monta o system prompt com orçamento por PRIORIDADE em vez de slice() cego.
// Ordem (também a prioridade de corte, do mais protegido ao mais descartável):
//   base + perfil (PINNED, nunca cortados) → skills de discovery → corpos de skills ativadas →
//   contexto recuperado (RAG, ELÁSTICO: truncado/omitido primeiro quando o orçamento aperta).
// O histórico e a query formam a lista de mensagens; ambos têm espaço reservado no orçamento.
export class ContextAssembler {
  assemble(input: AssembleInput): AssembleOutput {
    const budget = input.inputBudgetTokens ?? Number.POSITIVE_INFINITY;
    const reserveQuery = estimateTokens(input.query) + 8;
    const reserveHistory = input.history.length > 0 ? 256 : 0; // piso para manter o turno mais recente

    type Section = { text: string; pinned: boolean; skillName?: string };
    const candidates: Section[] = [{ text: input.basePrompt, pinned: true }];

    if (input.projectProfile && input.projectProfile.trim().length > 0) {
      candidates.push({
        text: `# Perfil do projeto (convenções do time — siga à risca)\n${input.projectProfile.trim()}`,
        pinned: true,
      });
    }
    if (input.discoverySkills.length > 0) {
      const lines = input.discoverySkills
        .map((s) => `- ${s.name}: ${s.description.replace(/\s+/g, " ").trim()}`)
        .join("\n");
      candidates.push({ text: `# Skills disponíveis (discovery)\n${lines}`, pinned: false });
    }
    for (const { meta, body } of input.activatedSkills) {
      candidates.push({ text: `# Skill ativada: ${meta.name}\n${body.trim()}`, pinned: false, skillName: meta.name });
    }
    if (input.retrievedContext.trim().length > 0) {
      candidates.push({ text: `# Contexto do código recuperado\n${input.retrievedContext.trim()}`, pinned: false });
    }

    // PINNED entram sempre; as demais enquanto couberem. A primeira que estourar é truncada (se sobrar
    // espaço útil) e o restante é omitido. Reserva espaço para a query e para o histórico mínimo.
    const cap = budget - reserveQuery - reserveHistory;
    const out: string[] = [];
    // Só as skills cujo corpo REALMENTE entrou no prompt (cheias OU truncadas) são "ativas": antes retornava
    // TODAS as input.activatedSkills, então uma skill DROPADA pelo orçamento ainda era anunciada à UI
    // (stream/skill), à obs (skill.activated) e aos headers do trace — o modelo nunca a viu (achado do survey).
    const emittedSkills: string[] = [];
    let used = 0;
    for (const c of candidates) {
      const cost = estimateTokens(c.text) + 2;
      if (c.pinned || used + cost <= cap) {
        out.push(c.text);
        used += cost;
        if (c.skillName) emittedSkills.push(c.skillName);
        continue;
      }
      const room = cap - used;
      if (room > 256) {
        out.push(`${truncateToTokens(c.text, room - 8)}\n[contexto truncado por orçamento]`);
        used = cap;
        if (c.skillName) emittedSkills.push(c.skillName); // truncada = parcialmente presente (header + início) → ainda ativa
      }
      break;
    }
    const systemPrompt = out.join("\n\n");

    // Histórico orçado com o que sobrou (mensagens mais recentes primeiro), preservando a query.
    const historyBudget = Math.max(0, budget - used - reserveQuery);
    const history = historyWithinBudget(input.history, historyBudget);
    const messages: ChatMessage[] = [...history, { role: "user", content: input.query }];

    return {
      systemPrompt,
      messages,
      activatedSkillNames: emittedSkills,
    };
  }
}
