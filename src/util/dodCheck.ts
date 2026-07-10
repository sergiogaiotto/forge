// Gate de DEFINIÇÃO DE PRONTO (DoD) (P2): um projeto que COMPILA e TIPA ainda pode NÃO estar pronto —
// sem manifesto de dependências ninguém instala; sem nenhum teste nada prova que roda; sem um README
// dizendo "como rodar" ninguém sobe o projeto. O compileall/mypy não pegam isso (é AUSÊNCIA, não erro de
// código). Diferente do gate de arquitetura (que aponta UM arquivo culpado), a "definição de pronto" é uma
// propriedade do CONJUNTO: a falta não se atribui a um arquivo. Este módulo é a fitness function
// determinística — PURO/testável. O Controller.runProjectGate coleta os inputs (propostas desta rodada +
// arquivos já aplicados) e chama evaluateDodGate: quando o conjunto está COMPLETO e um requisito falta,
// BLOQUEIA o Aplicar de TODOS (bloqueio + aviso; NÃO entra no auto-reparo — "gere o teste que falta" é bloco
// de arquivo NOVO, que o reparo de type-drift descarta). CONSERVADOR por desenho: reconhece a PRESENÇA de
// forma liberal e NUNCA acusa ausência de algo cujo conteúdo/estado não sabe avaliar (README .rst/.txt,
// arquivo truncado, arquivo já aplicado no disco) — o erro seguro é NÃO bloquear.
import { ProjectLanguage } from "../shared/protocol";

// Os três requisitos de "pronto" que checamos. `readme-run` cobre tanto a falta do README quanto um
// README Markdown de conteúdo confiável sem seção de execução.
export type DodRequirement = "manifest" | "tests" | "readme-run";

export interface DodFinding {
  requirement: DodRequirement;
  message: string; // pt-BR, acionável — vira o aviso do gate e o item bloqueante
}

// Um arquivo do projeto para efeito de DoD. `content` é OPCIONAL: presente/confiável só para propostas
// COMPLETAS desta rodada; ausente (undefined) para arquivos cujo conteúdo não podemos avaliar — truncados
// (parciais) ou já aplicados no disco. Nesses casos o arquivo conta pela PRESENÇA (path), nunca pela falta.
export interface DodFile {
  path: string;
  content?: string;
}

function norm(p: string): string {
  return (p ?? "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/").toLowerCase();
}

function baseOf(path: string): string {
  return norm(path).split("/").pop() ?? "";
}

// Manifesto de dependências Python: qualquer um destes SATISFAZ (basta existir — checagem por PATH). Cobre
// requirements.txt e variantes (requirements-dev.txt), a pasta requirements/*.txt, e os manifestos de
// empacotamento/ambiente.
function isManifest(path: string): boolean {
  const p = norm(path);
  return (
    /(^|\/)requirements[^/]*\.txt$/.test(p) ||
    /(^|\/)requirements\/[^/]+\.txt$/.test(p) ||
    /(^|\/)(pyproject\.toml|setup\.py|setup\.cfg|pipfile|environment\.ya?ml)$/.test(p)
  );
}

// Arquivo de TESTE segundo a descoberta padrão do pytest (test_*.py / *_test.py em qualquer lugar), OU um
// .py sob um diretório tests/ | test/ (exceto __init__.py — pacote vazio não é teste). Só checamos a
// PRESENÇA de um arquivo de teste; se ele PASSA é papel do smoke test advisory (P4), não deste gate.
function isTestFile(path: string): boolean {
  const p = norm(path);
  if (!p.endsWith(".py")) return false;
  const base = baseOf(p);
  if (/^test_.+\.py$/.test(base) || /.+_test\.py$/.test(base)) return true;
  const dirs = p.split("/").slice(0, -1);
  return dirs.some((d) => d === "tests" || d === "test") && base !== "__init__.py";
}

// README (para efeito de PRESENÇA): qualquer README* comum. Não confunde caixa nem extensão.
function isReadme(path: string): boolean {
  return /^readme(\.(md|markdown|rst|txt))?$/.test(baseOf(path));
}

// README cujo conteúdo dá para checar a seção de execução: SÓ Markdown (.md/.markdown). RST/.txt/sem
// extensão usam sintaxe própria (heading sublinhado, blocos `::`, prosa) que o matcher Markdown não
// entende — checá-los com regras de Markdown geraria falso-positivo. Esses contam pela mera presença.
function isMarkdownReadme(path: string): boolean {
  return /^readme\.(md|markdown)$/.test(baseOf(path));
}

// Termos (pt/en/es) que num heading indicam "como rodar/instalar/usar". Sem `.*` — casamento linear, sem
// risco de backtracking catastrófico. `c[óo]mo` + `ejecu` cobrem "## Cómo ejecutar" (a doc do
// package.nls.es o cita — o detector precisa honrar a promessa; achado da revisão do PR 11).
const RUN_KEYWORDS = /c[óo]mo\s+(rodar|executar|usar|começar|iniciar|instalar|ejecutar|correr|empezar)|instala|configura|setup|getting\s+started|quick\s?start|usage|running|\brun\b|execu|ejecu|deploy/i;

// Seção de execução num README MARKDOWN: um heading (#..######) contendo um termo de execução, OU um bloco
// de código cercado (```/~~~) — quase sempre o comando de instalação/execução. Processa LINHA A LINHA
// (trabalho linear no tamanho do conteúdo) — de propósito, para evitar o ReDoS de um regex com `\s+.*`
// ambíguo sobre o conteúdo verbatim do LLM.
function hasMarkdownRunSection(content: string): boolean {
  for (const line of (content ?? "").split(/\r?\n/)) {
    if (/^\s{0,3}(```|~~~)/.test(line)) return true;
    if (/^\s{0,3}#{1,6}\s/.test(line) && RUN_KEYWORDS.test(line)) return true;
  }
  return false;
}

// Avalia a definição de pronto sobre o CONJUNTO de arquivos do projeto. Retorna um achado por requisito
// ausente; vazio = pronto. PURO. Só Python por ora (os matchers são à moda Python); outras linguagens
// retornam [] (não bloqueiam) até o DoD ser estendido junto com o gate multi-linguagem. O chamador só deve
// avaliar quando o conjunto está COMPLETO (todo o blueprint gerado) — ver evaluateDodGate.
export function checkDefinitionOfDone(files: DodFile[], language: ProjectLanguage): DodFinding[] {
  if (language !== "python") return [];
  const findings: DodFinding[] = [];

  if (!files.some((f) => isManifest(f.path))) {
    findings.push({
      requirement: "manifest",
      message:
        "Sem manifesto de dependências (requirements.txt / pyproject.toml): ninguém consegue instalar o projeto. Gere um manifesto declarando as dependências.",
    });
  }

  if (!files.some((f) => isTestFile(f.path))) {
    findings.push({
      requirement: "tests",
      message:
        "Nenhum teste gerado (test_*.py ou tests/): nada prova que o projeto de fato roda. Gere ao menos um teste do caminho principal.",
    });
  }

  const readmes = files.filter((f) => isReadme(f.path));
  if (readmes.length === 0) {
    findings.push({
      requirement: "readme-run",
      message: "Sem README: falta o \"como rodar\". Gere um README.md com uma seção \"## Como rodar\" (instalar deps + executar).",
    });
  } else {
    // Só dá para faltar a "seção de execução" num README MARKDOWN de conteúdo CONFIÁVEL. Se algum README é
    // presença-apenas (.rst/.txt/sem extensão, ou truncado/aplicado sem conteúdo), não bloqueamos — a
    // existência já cumpre o requisito e não sabemos avaliar seu formato/estado (erro seguro é NÃO bloquear).
    const checkable = readmes.filter((f) => isMarkdownReadme(f.path) && typeof f.content === "string");
    const presenceOnly = checkable.length < readmes.length;
    if (!presenceOnly && !checkable.some((f) => hasMarkdownRunSection(f.content as string))) {
      findings.push({
        requirement: "readme-run",
        message: "O README não tem seção de execução (\"## Como rodar\" ou um bloco de comando): documente como instalar e rodar.",
      });
    }
  }

  return findings;
}

// Decisão de BLOQUEIO do DoD a partir do estado do projeto (PURO/testável — o Controller só coleta os
// inputs e reage). Bloqueia SÓ quando habilitado E o conjunto está COMPLETO. Monta o universo do projeto
// unindo as propostas desta rodada (as PARCIAIS entram por presença — conteúdo indisponível, não confiável)
// aos arquivos já APLICADOS em rodadas anteriores (existem no disco; entram por presença). Assim o DoD
// nunca acusa ausência de algo que existe em memória (parcial) ou no disco (aplicado / multi-rodada) — os
// falsos-positivos que a revisão adversarial pegou.
export function evaluateDodGate(input: {
  complete: boolean;
  enabled: boolean;
  language: ProjectLanguage;
  proposals: { path: string; content: string; partial?: boolean }[];
  appliedPaths?: string[];
}): { blocks: boolean; errors: string[] } {
  if (!input.enabled || !input.complete) return { blocks: false, errors: [] };
  const files: DodFile[] = [
    ...input.proposals.map((p) => ({ path: p.path, content: p.partial ? undefined : p.content })),
    ...(input.appliedPaths ?? []).map((path) => ({ path, content: undefined })),
  ];
  const errors = checkDefinitionOfDone(files, input.language).map((f) => f.message);
  return { blocks: errors.length > 0, errors };
}
