// Reparo de protocolo (Onda 3) — DETECÇÃO. Reconhece o sintoma do print: a geração terminou SEM nenhum
// bloco forge-file (logo, sem proposta aplicável com botão "Aplicar"), mas o modelo MOSTROU o conteúdo de
// um arquivo em cerca comum de três crases e pediu, em prosa, para o dev "substituir/criar" o arquivo.
// Puro/testável — a reemissão (I/O do provedor) fica no Task (repairProtocol). Ver systemPrompt.ts
// (buildProtocolReemitPrompt) e a integração em core/Task.ts.
import { parseFileBlocks } from "./fileBlocks";

// Um bloco cercado por >=3 crases: abertura com info-string na mesma linha, conteúdo, e fechamento com o
// MESMO número de crases (backreference \1). Casa ```python … ``` e ```` … ```` (4 crases). Como só
// chamamos o detector quando parseFileBlocks === 0, qualquer cerca aqui é "comum" (não é um forge-file).
const FENCE_RE = /(`{3,})[^\n`]*\n([\s\S]*?)\n\1(?:\r?\n|$)/g;

// Intenção de EDIÇÃO de arquivo na PROSA (fora das cercas): um verbo de aplicar/gravar. É o que separa
// "mostrei um arquivo pra você aplicar" (o sintoma) de "expliquei com um exemplo ilustrativo".
const EDIT_VERB =
  /\b(substitu\w+|troqu\w+ o conte[úu]do|conte[úu]do (completo )?d[eo]\b|cri[ae]r? o arquivo|no arquivo\b|salv\w+ (isso |o arquivo )?em|atualiz\w+ o arquivo|edit\w+ o arquivo|coloqu\w+ (isso |o c[óo]digo )?em|adicion\w+ (o|um) arquivo)/i;

// Menção a um caminho de arquivo com extensão conhecida (na prosa). O grupo 2 é o caminho.
const FILE_PATH =
  /(^|[\s`("'>])([\w][\w./-]*\.(py|ipynb|ts|tsx|js|jsx|java|go|rs|rb|sql|scala|kt|json|ya?ml|toml|md|cfg|ini|txt|sh))\b/i;

// PISTA de PROPOSTA que qualifica uma menção a caminho como "arquivo a aplicar" (não didática): o modelo
// está entregando o arquivo ("segue", "aqui está", "corrigido", "nova versão"). Sem uma pista destas, um
// caminho sozinho é apenas uma referência ("o arquivo X controla Y") e NÃO deve disparar a reemissão.
const PROPOSAL_CUE =
  /\b(corrig\w+|atualiz\w+|segue\b|aqui (est[áa]|vai)|nova vers[ãa]o|vers[ãa]o (final|corrigid\w+|nova)|arquivo (final|completo|corrigid\w+|atualizad\w+)|c[óo]digo (final|completo|corrigid\w+))\b/i;

export interface ProseEditSignal {
  path?: string; // caminho mencionado na prosa (para a mensagem ao usuário), quando houver
}

// Retorna não-nulo quando a resposta parece DESCREVER uma edição de arquivo sem tê-la emitido como
// forge-file (candidata a reemissão silenciosa). CONSERVADOR — exige as três condições:
//   (1) NENHUM bloco forge-file (senão já há proposta aplicável — nada a reparar);
//   (2) ao menos uma cerca comum com corpo REAL (>= 2 linhas não-vazias) — não dispara por um comando
//       de shell de uma linha nem por prosa pura;
//   (3) intenção de edição na PROSA (fora das cercas): um VERBO de aplicar (substituir/criar/atualizar)
//       OU um caminho de arquivo acompanhado de uma PISTA DE PROPOSTA ("segue", "corrigido", "aqui
//       está"…). Um caminho SOZINHO (menção didática, "o arquivo X controla Y") NÃO dispara. Buscar só
//       na prosa evita casar um caminho/verbo que esteja DENTRO do código.
// Um falso-positivo custa apenas UMA reemissão barata que o modelo pode declinar (não emite bloco), e o
// aviso ao usuário só aparece quando um arquivo é de fato recuperado (ver Task.repairProtocol).
export function detectProseFileEdit(fullText: string): ProseEditSignal | null {
  if (!fullText) return null;
  if (parseFileBlocks(fullText).length > 0) return null; // já há proposta aplicável

  let hasCodeFence = false;
  let prose = "";
  let last = 0;
  FENCE_RE.lastIndex = 0;
  for (let m = FENCE_RE.exec(fullText); m; m = FENCE_RE.exec(fullText)) {
    const nonEmpty = m[2].split("\n").filter((l) => l.trim() !== "").length;
    if (nonEmpty >= 2) hasCodeFence = true;
    prose += fullText.slice(last, m.index) + " "; // acumula só o texto FORA das cercas
    last = m.index + m[0].length;
  }
  prose += fullText.slice(last);
  if (!hasCodeFence) return null;

  const pathMatch = prose.match(FILE_PATH);
  const intent = EDIT_VERB.test(prose) || (pathMatch !== null && PROPOSAL_CUE.test(prose));
  if (!intent) return null;
  return { path: pathMatch ? pathMatch[2] : undefined };
}
