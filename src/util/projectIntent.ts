// Classificação de intenção do Modo Projeto (Fase F): com o toggle "Projeto" ligado, NEM toda
// mensagem é um pedido de gerar um projeto. Colar logs/erros e perguntar "o que aconteceu?" deve
// ser RESPONDIDO no chat, não virar um Blueprint. Este heurístico decide entre:
//   - "generate": criar/scaffoldar um projeto (fluxo de Blueprint)
//   - "chat":     pergunta/diagnóstico (resposta normal, mesmo com o Modo Projeto ligado)
// Puro e sem dependências (importável pela webview e pelo host) — testável isoladamente.
//
// ORDEM (a primeira regra que casa vence) é deliberada:
//   1. Pedido de GERAR no início ("crie…", "você poderia criar…") → generate.  Vence QUALQUER menção
//      de erro/log — inclusive uma linha de exemplo colada abaixo do pedido ("Crie um logger\nINFO: …").
//   2. Proposta de artefato ("que tal um app…?") → generate.
//   3. Log/stacktrace COLADO (estrutural, multilinha) → chat.  Só chega aqui quem NÃO começa com um
//      pedido de gerar; então é um log de verdade (começa com timestamp/nível/Traceback), não um brief.
//   4. Frase diagnóstica em linguagem natural ("o que aconteceu", "me explica", "por que") → chat.
//   5. Qualquer pergunta restante (termina em "?") → chat.
//   6. Default do Modo Projeto: generate (descrição de um artefato a construir).

export type ProjectIntent = "generate" | "chat";

// 3. Log/stacktrace colado. Sinais ESTRUTURAIS ancorados a início de linha (flag "m"), para que um
// token de erro no meio de um brief ("…retorna ERROR 500", "…trata Exception") NÃO dispare "chat".
// Testado DEPOIS de REQUEST_START/PROPOSAL_START: um brief pode conter uma linha de log de exemplo.
const STRONG_LOG = new RegExp(
  [
    String.raw`^Traceback \(most recent call last\):`, // Python
    String.raw`^\s*File ".+", line \d+`, // frame Python
    String.raw`^\s*at \S.*:\d+:\d+`, // frame JS/Node (com ou sem parênteses)
    String.raw`^\s*[\w.]*(Error|Exception|Warning):`, // linha de exceção: ValueError:, ConnectionRefusedError:
    String.raw`^\s*(INFO|DEBUG|WARNING|WARN|ERROR|CRITICAL|FATAL):`, // nível de log no início (uvicorn "INFO:")
    String.raw`"(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS) [^"]*" \d{3}`, // access log HTTP ("GET / HTTP/1.1" 404)
    String.raw`^npm ERR!`,
    String.raw`^\s*\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}`, // linha com timestamp ISO
    String.raw`\[AVISO\]|\[ERRO\]`, // marcadores em colchete (pt)
  ].join("|"),
  "im"
);

// 1. Pedido de GERAÇÃO no início: verbo imperativo, com cortesia/modal opcional antes ("pode criar…",
// "você poderia gerar…", "tem como fazer…", "dá pra construir…").
const REQUEST_START =
  /^\s*(por favor,?\s+|me\s+ajud\w+\s+a\s+|voc[êe]\s+(pode|poderia|consegue)\s+|tem\s+como\s+|seria\s+poss[íi]vel\s+|d[áa]\s+pra\s+|d[áa]\s+para\s+|pode(ria|s)?\s+|consegue\s+|quero\s+|queria\s+|preciso\s+(de\s+)?|gostaria\s+de\s+|vou\s+|vamos\s+)?(crie|criar|cria|gere|gerar|gera|construa|construir|constr[óo]i|monte|montar|desenvolv\w+|implement\w+|fa[çc]a|fazer|escrev\w+|refa[çc]a|refatore|scaffold|create|build|generate|develop|implement|make|write)\b/i;

// 2. Proposta de artefato como pergunta ("que tal um X?", "pode ser um Y?").
const PROPOSAL_START = /^\s*(que tal|pode ser|podia ser|poderia ser|e se|bora)\b/i;

// 4. Pergunta/pedido de explicação em linguagem natural (o "?" é opcional aqui).
const DIAGNOSTIC_PHRASE =
  /\b(o que aconteceu|o que houve|que erro (é|e|deu)|n[ãa]o entendi|me explica|me explique|explica esse|explique esse|o que significa|por que|por qu[êe]|what happened|why (is|does|did|are)|what does this)\b/i;

export function classifyProjectIntent(text: string): ProjectIntent {
  const t = (text ?? "").trim();
  if (!t) return "generate";
  if (REQUEST_START.test(t)) return "generate"; // 1. "crie …", "você poderia criar …", "quero gerar …"
  if (PROPOSAL_START.test(t)) return "generate"; // 2. "que tal um app …?"
  if (STRONG_LOG.test(t)) return "chat"; // 3. log/stacktrace colado (sem pedido de gerar à frente)
  if (DIAGNOSTIC_PHRASE.test(t)) return "chat"; // 4. "o que aconteceu", "me explica", "por que"…
  if (/\?\s*$/.test(t)) return "chat"; // 5. qualquer pergunta restante → responde no chat
  return "generate"; // 6. default do Modo Projeto
}

// R3: no Modo Projeto o dev escolhe a arquitetura no wizard (dado ESTRUTURADO), mas o seletor de skills só vê
// o BRIEF ("gerenciador de senhas") — que não carrega os tokens distintivos (hexagonal/ports/adapters). Então
// a skill carro-chefe `hexagonal-backend` NÃO ativa por léxico, e a geração perde o playbook alinhado aos gates
// (layout flat que boota, DoD, Protocol/ABC). O host FORÇA a ativação pela ESCOLHA explícita do wizard. Como é
// dado estruturado — não heurística de texto — NUNCA sequestra o público de DADOS, ao contrário do over-trigger
// léxico que a skill teve de evitar. Dispara para a FAMÍLIA ports/adapters que a skill anuncia cobrir (a própria
// description cita "clean architecture, dependency inversion"): `hexagonal` E `clean` — ambas compartilham
// inversão-de-dependência + fronteiras por interface, e o playbook (layout flat, Protocol/ABC, fake-adapters) é
// Python-level, agnóstico entre as duas. NÃO dispara p/ `layered`/`mvc` (paradigmas sem ports — o playbook não
// encaixa) nem fora de Python (a skill é FastAPI/Flask). Params estruturais para manter o módulo puro. Puro.
export function forcesHexagonalBackend(mode: string, project?: { language?: string; architecture?: string }): boolean {
  return (
    mode === "project" &&
    project?.language === "python" &&
    (project?.architecture === "hexagonal" || project?.architecture === "clean")
  );
}
