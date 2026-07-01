// Redação best-effort de segredos em texto exibido ao dev (ex.: preview de chunks do RAG no
// visualizador). NÃO é uma fronteira de segurança — é defesa em profundidade para que um segredo que
// por acaso tenha sido indexado não apareça literalmente na UI. Puro/testável.
//
// Só mascara VALORES que parecem segredo: uma string entre aspas OU um token longo (>=8 chars sem
// espaços/parênteses). Assim `token = compute()` / `secret = load()` (código legítimo) NÃO é tocado —
// preserva a utilidade do preview — mas `api_key: "sk-…"` / `password=hunter2secret123` some.
const SECRET_KEY = "(?:api[_-]?key|secret|client[_-]?secret|token|password|passwd|pwd|access[_-]?key|private[_-]?key|authorization)";
// valor = string entre aspas OU token de 8+ chars que CONTÉM um dígito (chaves/API tokens têm; um
// identificador de código como `response.json`/`load_secret` não — e assim é preservado).
const SECRET_VALUE = "(['\"][^'\"\\n]{3,}['\"]|(?=[A-Za-z0-9._+/=-]*[0-9])[A-Za-z0-9._+/=-]{8,})";
const KV = new RegExp(`(${SECRET_KEY}\\s*[:=]\\s*)${SECRET_VALUE}`, "gi");
const BEARER = /(bearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi;

export function redactSecrets(text: string): string {
  if (!text) return text;
  return text.replace(KV, "$1«oculto»").replace(BEARER, "$1«oculto»");
}
