import { EgressEnforcer } from "../../net/EgressEnforcer";
import { ProviderRuntimeConfig } from "../types";
import { OpenAICompatibleProvider } from "./OpenAICompatibleProvider";

// OpenAI é apenas o endpoint canônico compatível com OpenAI, com um baseUrl fixo.
export class OpenAIProvider extends OpenAICompatibleProvider {
  override readonly type = "openai" as const;

  constructor(cfg: ProviderRuntimeConfig, egress: EgressEnforcer) {
    super({ ...cfg, baseUrl: cfg.baseUrl || "https://api.openai.com/v1" }, egress);
  }
}
