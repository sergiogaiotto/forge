// Redação de segredos/PII em texto de EGRESSO (auto-read → gateway, bundle de diagnóstico, contexto Langfuse)
// e no preview de chunks do RAG. NÃO é fronteira de segurança — é defesa em profundidade para que um segredo
// que por acaso vaze no conteúdo não saia literal. Os PADRÕES vivem numa ÚNICA fonte compartilhada com o
// GATEWAY (gateway/redaction.mjs) — antes divergiam (o cliente só pegava KV+Bearer; o gateway só sk-/pk-/
// email/dígitos), então connection string / PEM / JWT / AWS escapavam de um lado ou do outro. (#8)
//
// O esbuild bundla o .mjs no dist da extensão; o gateway o importa nativo. Mantido o nome `redactSecrets`
// (todos os chamadores dependem dele). Puro/testável.
import { redact } from "../../gateway/redaction.cjs";

export function redactSecrets(text: string): string {
  return redact(text);
}
