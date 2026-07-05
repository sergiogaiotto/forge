// Gate WORKSPACE-WIDE do Modo Projeto: em vez de medir só a PRESENÇA dos arquivos (o gate antigo,
// que marcava "complete" por existir), materializa TODAS as propostas juntas numa árvore temporária e
// roda compileall + mypy sobre o CONJUNTO — pegando o drift de contrato cross-file (ex.: importar um
// `OrderStatus` que nenhum arquivo define) que só aparece quando os arquivos são vistos JUNTOS.
//
// Este módulo é PURO (materialização/parse/decisão testáveis sem spawnar processo). O I/O (mkdtemp,
// spawn do python) fica no Controller.runProjectGate, que orquestra e alimenta `entry.gateOk`.
import * as path from "node:path";
import { ValidatorResult } from "../shared/protocol";

export const SYNTHETIC_INIT = "__init__.py";

// Normaliza um caminho relativo para casar propostas × saída das ferramentas: separadores pra frente,
// sem `./` inicial. NÃO mexe em caixa (paths são case-sensitive em Linux). O colapso de barras duplas é
// ESSENCIAL: no Windows, o `*** Error compiling {!r}...` do compileall usa repr(), que DOBRA as barras
// invertidas (`.\\adapters\\x.py`) — sem colapsar, viraria `/adapters//x.py` e não casaria a proposta.
export function normGatePath(p: string): string {
  return (p ?? "")
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "")
    .trim();
}

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

// Um diretório só pode virar pacote Python se TODOS os seus segmentos forem identificadores válidos
// (letra/underscore seguidos de word-chars). Diretórios comuns em projetos gerados como `my-app`,
// `api-v2`, `order.service` ou `2fa` NÃO são: semear `__init__.py` neles faz o mypy ABORTAR (exit 2,
// "X contains __init__.py but is not a valid Python package name") sem atribuir erro — e o abort MASCARA
// o drift real de pacotes VÁLIDOS na mesma run. Sem o `__init__.py`, o mypy checa o arquivo standalone e
// ainda atribui os erros. (Achado da revisão adversarial, reproduzido ao vivo com mypy 2.1.0.)
const PKG_SEGMENT = /^[A-Za-z_]\w*$/;
function isPackageDir(dir: string): boolean {
  return dir.split("/").every((seg) => PKG_SEGMENT.test(seg));
}

// Diretórios que precisam de um `__init__.py` SINTÉTICO para virarem pacotes Python importáveis (sem
// isso, `from a.b.c import X` não resolve no mypy e o gate perderia o drift cross-file). Regra: todo
// ancestral de um `.py` é candidato a pacote; a RAIZ (string vazia) nunca vira pacote; diretórios que já
// têm um `__init__.py` entre as próprias propostas são pulados (não sobrescreve o do modelo); e nomes
// que não são identificadores Python válidos são EXCLUÍDOS (senão o mypy aborta e mascara o drift). Puro.
export function syntheticInitDirs(relPaths: string[]): string[] {
  const norm = relPaths.map(normGatePath).filter(Boolean);
  const alreadyPkg = new Set(
    norm.filter((p) => p === SYNTHETIC_INIT || p.endsWith("/" + SYNTHETIC_INIT)).map((p) => dirOf(p))
  );
  const needed = new Set<string>();
  for (const p of norm) {
    if (!p.toLowerCase().endsWith(".py")) continue;
    let dir = dirOf(p);
    while (dir) {
      needed.add(dir);
      dir = dirOf(dir);
    }
  }
  return [...needed].filter((d) => !alreadyPkg.has(d) && isPackageDir(d)).sort();
}

// Relativiza um caminho da SAÍDA da ferramenta contra a raiz temp e normaliza. As ferramentas rodam com
// cwd=raiz e argumento `.`, então emitem caminhos relativos; o ramo absoluto é defensivo.
function relToRoot(root: string, p: string): string {
  const raw = (p ?? "").trim();
  if (raw && (path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw))) {
    return normGatePath(path.relative(root, raw));
  }
  return normGatePath(raw);
}

function push(map: Map<string, string[]>, key: string, ...msgs: string[]): void {
  if (!key) return;
  const arr = map.get(key) ?? [];
  arr.push(...msgs);
  map.set(key, arr);
}

// compileall (-q) imprime `*** Error compiling '<path>'...` seguido do traceback do SyntaxError. Ancora
// no path e acumula as linhas seguintes (a mensagem) até a próxima âncora/linha em branco. Puro.
export function parseCompileallErrors(output: string, root = ""): Map<string, string[]> {
  const map = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of (output ?? "").split(/\r?\n/)) {
    const m = /Error compiling ['"]?(.+?)['"]?(?:\.\.\.)?\s*$/.exec(line);
    if (m) {
      current = relToRoot(root, m[1]);
      push(map, current, line.trim());
      continue;
    }
    if (!line.trim()) {
      current = null;
      continue;
    }
    if (current) push(map, current, line.trim());
  }
  return map;
}

// mypy imprime `path:line[:col]: error|note: msg [code]`. Coleta só `error` (notes são contexto). Puro.
export function parseMypyErrors(output: string, root = ""): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const line of (output ?? "").split(/\r?\n/)) {
    const m = /^(.*?):(\d+):(?:\d+:)?\s*(error|note):\s*(.*)$/.exec(line);
    if (!m || m[3] !== "error") continue;
    push(map, relToRoot(root, m[1]), `linha ${m[2]}: ${m[4].trim()}`);
  }
  return map;
}

// mypy não instalado ≠ mypy reprovou: `python -m mypy` sem o pacote sai != 0 com "No module named mypy"
// (não é ENOENT — o python EXISTE). Nesse caso o gate degrada para consultivo, não bloqueia.
export function mypyUnavailable(result: ValidatorResult): boolean {
  if (result.status === "skipped") return true;
  if (result.status !== "failed") return false;
  return /no module named ['"]?mypy|mypy: (command )?not found|is not recognized as an internal|modulenotfounderror: no module named ['"]mypy/i.test(result.output ?? "");
}

// Um resultado de checagem já rodado (result) mais os erros por-arquivo extraídos da sua saída.
export interface GateCheckResult {
  result: ValidatorResult;
  errors: Map<string, string[]>;
}

export interface ProjectGateSummary {
  advisory: boolean; // nenhuma checagem de GATE conseguiu rodar → nada é bloqueado
  ran: string[]; // labels das checagens que executaram (ok ou failed)
  skipped: string[]; // labels puladas (não instaladas / timeout)
  fileErrors: { path: string; errors: string[] }[]; // atribuídos a um arquivo → bloqueiam esse arquivo
  projectErrors: string[]; // reprovou SEM atribuir a arquivo → bloqueia todos os .py (fallback)
  summary: string;
}

// Consolida os resultados das checagens numa decisão de gate. Só uma checagem de GATE (gate:true) que
// REALMENTE rodou e reprovou (status "failed") contribui bloqueio — skipped nunca bloqueia (degradação
// segura). Uma reprovação sem erro atribuível a arquivo vira `projectErrors` (bloqueio amplo). Puro.
export function summarizeGate(checks: GateCheckResult[]): ProjectGateSummary {
  const ran: string[] = [];
  const skipped: string[] = [];
  const merged = new Map<string, string[]>();
  const projectErrors: string[] = [];
  let anyGateRan = false;

  for (const c of checks) {
    const r = c.result;
    if (r.status === "skipped") {
      skipped.push(r.label);
      continue;
    }
    ran.push(r.label);
    if (r.gate) anyGateRan = true;
    if (r.status === "failed" && r.gate) {
      if (c.errors.size > 0) {
        for (const [file, msgs] of c.errors) push(merged, file, ...msgs);
      } else {
        // Reprovou mas o parser não localizou o arquivo — mantém a força do gate: bloqueia amplo.
        projectErrors.push(`${r.label}: ${(r.output || "reprovou sem detalhes").slice(0, 600)}`);
      }
    }
  }

  const fileErrors = [...merged]
    .map(([p, errors]) => ({ path: p, errors }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const advisory = !anyGateRan;
  const mypyRan = ran.some((l) => /mypy/i.test(l)); // o mypy é o que pega o DRIFT de contrato cross-file
  // Só BLOQUEIA arquivos com erro ATRIBUÍDO (a ferramenta apontou o arquivo). Uma reprovação sem
  // atribuição (traceback do próprio tooling, env quebrado) é ANÔMALA e vira aviso não-bloqueante — não
  // dá para saber se é defeito do código ou da ferramenta, e um bloqueio amplo por env seria falso.
  const summary = advisory
    ? "Gate consultivo: compileall/mypy indisponíveis no ambiente — nada foi bloqueado (o projeto pode não rodar)."
    : fileErrors.length > 0
      ? `Gate reprovou: ${fileErrors.length} arquivo(s) não compilam/importam. O "Aplicar" deles está bloqueado até corrigir.`
      : projectErrors.length > 0
        ? "Gate rodou mas não consegui localizar a falha por arquivo (veja os detalhes) — nada foi bloqueado."
        : mypyRan
          ? "Gate verde: o conjunto compila e importa (compileall + mypy sem erros de contrato)."
          : "Gate parcial: compilou sem erro de sintaxe (compileall), mas o mypy não rodou — o drift de contrato cross-file NÃO foi verificado.";

  return { advisory, ran, skipped, fileErrors, projectErrors, summary };
}
