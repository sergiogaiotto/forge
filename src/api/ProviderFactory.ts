import { EgressEnforcer } from "../net/EgressEnforcer";
import { AnthropicProvider } from "./providers/AnthropicProvider";
import { OpenAICompatibleProvider } from "./providers/OpenAICompatibleProvider";
import { OpenAIProvider } from "./providers/OpenAIProvider";
import { LLMProvider, ProviderRuntimeConfig } from "./types";

export function createProvider(cfg: ProviderRuntimeConfig, egress: EgressEnforcer): LLMProvider {
  switch (cfg.type) {
    case "anthropic":
      return new AnthropicProvider(cfg, egress);
    case "openai":
      return new OpenAIProvider(cfg, egress);
    case "openai-compatible":
      return new OpenAICompatibleProvider(cfg, egress);
    default:
      throw new Error(`Tipo de provedor desconhecido: ${(cfg as { type: string }).type}`);
  }
}
