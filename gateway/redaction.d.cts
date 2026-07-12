// Tipos do módulo compartilhado de redação (gateway/redaction.cjs, JS puro que roda no gateway sem build).
// O cliente (src/util/redact.ts, CommonJS) o importa com tsc Node16 → precisa deste .d.cts. (#8)
export function redact(text: string): string;
