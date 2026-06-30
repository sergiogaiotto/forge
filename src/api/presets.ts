import { ProviderPreset } from "../shared/protocol";

// RF-022: presets prontos para uso do HubGPU mais as entradas de provedor genéricas exibidas
// no assistente de onboarding.
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "hubgpu-120b",
    label: "HubGPU · gpt-oss-120b",
    type: "openai-compatible",
    baseUrl: "https://hub-gpus.claro.com.br/gpt120/v1",
    modelId: "openai/gpt-oss-120b",
    apiKeyDefault: "not-needed",
    note: "O proxy autentica por outra via (rede / SSO).",
  },
  {
    id: "hubgpu-20b",
    label: "HubGPU · gpt-oss-20b",
    type: "openai-compatible",
    baseUrl: "https://hub-gpus.claro.com.br/gpt20/v1",
    modelId: "openai/gpt-oss-20b",
    apiKeyDefault: "not-needed",
    note: "O proxy autentica por outra via (rede / SSO).",
  },
  {
    id: "openai",
    label: "OpenAI",
    type: "openai",
    baseUrl: "https://api.openai.com/v1",
    modelId: "gpt-4o",
    note: "Requer API key da OpenAI (egress externo deve estar liberado).",
  },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    type: "anthropic",
    modelId: "claude-sonnet-4-6",
    note: "Formato Messages nativo. Requer API key Anthropic.",
  },
];

export const DEFAULT_TIMEOUT_SECONDS = 300;

// Teto de tokens de SAÍDA padrão dos provedores OpenAI-compatíveis (HubGPU/gpt-oss). Generoso de
// propósito: um "arquivo completo" pode passar de vários milhares de tokens, e sem este teto o
// gateway aplicaria um default baixo (1024/4096) e truncaria a resposta silenciosamente.
// gpt-oss-120b tem janela de 128k, então 16k de saída é seguro com folga.
export const DEFAULT_MAX_TOKENS = 16384;
