import { hostT, HostMessageKey } from "../i18n";
import { ProviderPreset } from "../shared/protocol";

// RF-022: presets prontos para uso do HubGPU mais as entradas de provedor genéricas exibidas
// no assistente de onboarding. A `note` (exibida sob o campo API Key) NÃO vive aqui: é uma string
// user-visível, então mora no catálogo do host (hostMessages) e é resolvida por locale no momento
// do post — ver localizedProviderPresets (o array módulo-nível avaliaria ANTES do setHostLocale).
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "hubgpu-120b",
    label: "HubGPU · gpt-oss-120b",
    type: "openai-compatible",
    baseUrl: "https://hub-gpus.claro.com.br/gpt120/v1",
    modelId: "openai/gpt-oss-120b",
    apiKeyDefault: "not-needed",
  },
  {
    id: "hubgpu-20b",
    label: "HubGPU · gpt-oss-20b",
    type: "openai-compatible",
    baseUrl: "https://hub-gpus.claro.com.br/gpt20/v1",
    modelId: "openai/gpt-oss-20b",
    apiKeyDefault: "not-needed",
  },
  {
    id: "openai",
    label: "OpenAI",
    type: "openai",
    baseUrl: "https://api.openai.com/v1",
    modelId: "gpt-4o",
  },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    type: "anthropic",
    modelId: "claude-sonnet-4-6",
  },
];

const PRESET_NOTE_KEY: Record<string, HostMessageKey> = {
  "hubgpu-120b": "preset.note.hubgpu",
  "hubgpu-20b": "preset.note.hubgpu",
  openai: "preset.note.openai",
  anthropic: "preset.note.anthropic",
};

// Presets com a note resolvida no locale ATIVO do host — é o que o Controller posta no state
// (protocolo transporta string pronta; a webview nunca re-chaveia).
export function localizedProviderPresets(): ProviderPreset[] {
  const key = (id: string): HostMessageKey | undefined => PRESET_NOTE_KEY[id];
  return PROVIDER_PRESETS.map((p) => (key(p.id) ? { ...p, note: hostT(key(p.id)!) } : p));
}

export const DEFAULT_TIMEOUT_SECONDS = 300;

// Teto de tokens de SAÍDA padrão dos provedores OpenAI-compatíveis (HubGPU/gpt-oss). Generoso de
// propósito: um "arquivo completo" pode passar de vários milhares de tokens, e sem este teto o
// gateway aplicaria um default baixo (1024/4096) e truncaria a resposta silenciosamente.
// gpt-oss-120b tem janela de 128k, então 16k de saída é seguro com folga.
export const DEFAULT_MAX_TOKENS = 16384;
