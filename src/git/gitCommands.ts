// Git GOVERNADO (Fase 4 — capacidade seletiva). Lógica PURA (sem vscode/child_process): monta os args
// do git, parseia a saída e renderiza os cards. A EXECUÇÃO (spawn) e a GOVERNANÇA (confirmação de
// escrita via PermissionService) ficam no Controller. Escopo deliberadamente ENXUTO e não-destrutivo:
//   - LEITURA (sem confirmação): status, diff, log.
//   - ESCRITA (confirmação + auditoria): commit dos arquivos JÁ rastreados (git commit -a).
// Fora do escopo POR DESIGN: push/pull (egress — passaria pelo EgressEnforcer, é outra superfície),
// reset/checkout/rebase (destrutivos — perda de trabalho sem rede de segurança). Não é um agente: é uma
// superfície que o dev opera, com a escrita governada pelo mesmo trail de permissões do resto do FORGE.

export type GitOp = "status" | "diff" | "log" | "commit";

// Separador de campo do log: US (Unit Separator, \x1f). Improvável em nome de autor/assunto — parse
// robusto sem se confundir com "|"/espaço no assunto do commit.
const LOG_SEP = "\x1f";

export function isWriteOp(op: GitOp): boolean {
  return op === "commit";
}

// Argumentos do git por operação. `--no-pager` sempre (senão o git tenta abrir um pager e trava o
// spawn não-interativo). A mensagem de commit vai como ELEMENTO de array (nunca concatenada numa string
// de shell) — o spawn é shell:false, então nenhum metacaractere da mensagem do dev é interpretado.
export function buildGitArgs(op: GitOp, params: { message?: string; logCount?: number } = {}): string[] {
  switch (op) {
    case "status":
      return ["--no-pager", "status", "--porcelain=v1", "--branch"];
    case "diff":
      // --no-textconv: NÃO roda drivers de textconv (comando lido de .gitattributes/.git/config do repo)
      // — defesa em profundidade contra execução de código de um repo hostil na op de "leitura".
      return ["--no-pager", "diff", "--no-textconv", "HEAD"];
    case "log": {
      const n = Math.min(Math.max(params.logCount ?? 15, 1), 100);
      return ["--no-pager", "log", "-n", String(n), `--pretty=format:%h${LOG_SEP}%an${LOG_SEP}%ar${LOG_SEP}%s`];
    }
    case "commit":
      // -a: inclui os arquivos RASTREADOS modificados/removidos (untracked exigem add explícito — não
      // são varridos por engano). A mensagem é validada por sanitizeCommitMessage antes de chegar aqui.
      return ["commit", "-a", "-m", params.message ?? ""];
  }
}

export interface GitStatusEntry {
  index: string; // X (staged)
  worktree: string; // Y (working tree)
  path: string;
  origPath?: string; // origem, quando renomeado/copiado ("R  orig -> dest")
}

// Desfaz o C-quoting do git (git envolve em "..." e escapa quando o path tem espaço, aspas, controle ou
// — com core.quotepath=true — byte não-ASCII em octal \ddd). Sem isto, "café.ts"/"my file.ts" apareciam
// como lixo na card E na confirmação de commit (produto pt-BR: ç/á/ã são comuns). Reconstrói os bytes e
// decodifica UTF-8. PURO.
export function unquoteGitPath(raw: string): string {
  if (raw.length < 2 || raw[0] !== '"' || raw[raw.length - 1] !== '"') return raw;
  const inner = raw.slice(1, -1);
  const bytes: number[] = [];
  const esc: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c !== "\\") {
      for (const b of Buffer.from(c, "utf8")) bytes.push(b);
      continue;
    }
    const n = inner[i + 1];
    if (n >= "0" && n <= "7") {
      let oct = "";
      let j = i + 1;
      while (j < inner.length && oct.length < 3 && inner[j] >= "0" && inner[j] <= "7") oct += inner[j++];
      bytes.push(parseInt(oct, 8) & 0xff);
      i = j - 1;
      continue;
    }
    if (n !== undefined && n in esc) {
      bytes.push(esc[n]);
      i++;
      continue;
    }
    bytes.push(92); // escape desconhecido → mantém o backslash literal
  }
  return Buffer.from(bytes).toString("utf8");
}
export interface GitStatus {
  branch: string;
  upstream?: string;
  ahead: number;
  behind: number;
  entries: GitStatusEntry[];
}

// Parseia `git status --porcelain=v1 --branch`. Linha "## branch...upstream [ahead N, behind M]" +
// linhas "XY <path>". Formato ESTÁVEL (porcelain é contrato do git para scripts).
export function parseStatusPorcelain(output: string): GitStatus {
  const status: GitStatus = { branch: "", ahead: 0, behind: 0, entries: [] };
  for (const raw of output.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line) continue;
    if (line.startsWith("## ")) {
      const rest = line.slice(3);
      // "main...origin/main [ahead 1, behind 2]" | "main" | "No commits yet on main"
      const bracket = /\s\[(.+)\]$/.exec(rest);
      if (bracket) {
        const a = /ahead (\d+)/.exec(bracket[1]);
        const b = /behind (\d+)/.exec(bracket[1]);
        if (a) status.ahead = parseInt(a[1], 10);
        if (b) status.behind = parseInt(b[1], 10);
      }
      const head = rest.replace(/\s\[.+\]$/, "");
      const dots = head.indexOf("...");
      if (dots >= 0) {
        status.branch = head.slice(0, dots);
        status.upstream = head.slice(dots + 3);
      } else {
        status.branch = head.replace(/^No commits yet on /, "");
      }
      continue;
    }
    // "XY path" — X e Y são um caractere cada; o path começa na coluna 3.
    if (line.length >= 4) {
      const index = line[0];
      const worktree = line[1];
      const rawPath = line.slice(3);
      // Rename/cópia: "R  orig -> dest" (cada lado pode estar quotado). O alvo é o dest.
      if ((index === "R" || index === "C" || worktree === "R" || worktree === "C") && rawPath.includes(" -> ")) {
        const [orig, dest] = rawPath.split(" -> ");
        status.entries.push({ index, worktree, path: unquoteGitPath(dest ?? rawPath), origPath: unquoteGitPath(orig ?? "") });
      } else {
        status.entries.push({ index, worktree, path: unquoteGitPath(rawPath) });
      }
    }
  }
  return status;
}

// Arquivos que um `git commit -a` REALMENTE incluiria: rastreados com QUALQUER mudança já staged (index
// != ' '/'?') ou no worktree (worktree != ' '/'?' — cobre M, D, T[ypechange], R, C, não só M/D). Untracked
// ('??') NÃO entram. É a lista mostrada na confirmação — o dev vê exatamente o que será selado. A regra
// abrangente é deliberada: `git commit -a` == `git add -u`, que estagia typechange/rename também — omitir
// 'T' fazia o dialogo autorizar N e o git selar N+1 (furo de governança, achado da revisão).
export function commitTargets(status: GitStatus): string[] {
  const out: string[] = [];
  for (const e of status.entries) {
    if (e.index === "?" && e.worktree === "?") continue; // untracked
    const staged = e.index !== " " && e.index !== "?";
    const worktreeChanged = e.worktree !== " " && e.worktree !== "?";
    if (staged || worktreeChanged) out.push(e.path);
  }
  return out;
}

export interface GitCommitMessage {
  ok: boolean;
  message?: string;
  error?: string;
}
// Valida a mensagem de commit: não-vazia após trim, cap de tamanho. Não precisa ESCAPAR (vai como arg
// de array, shell:false), mas rejeita vazia (o git abriria um editor interativo → trava o spawn).
export function sanitizeCommitMessage(raw: string | undefined): GitCommitMessage {
  const msg = (raw ?? "").trim();
  if (!msg) return { ok: false, error: 'Informe a mensagem: `/git-commit "sua mensagem"`.' };
  if (msg.length > 2000) return { ok: false, error: "Mensagem muito longa (máx. 2000 caracteres)." };
  return { ok: true, message: msg };
}

const STATUS_LABEL: Record<string, string> = { M: "modificado", A: "adicionado", D: "removido", R: "renomeado", C: "copiado", U: "conflito", "?": "novo" };

function fileLabel(e: GitStatusEntry): string {
  if (e.index === "?" && e.worktree === "?") return "novo (não rastreado)";
  const staged = e.index !== " " && e.index !== "?" ? `staged: ${STATUS_LABEL[e.index] ?? e.index}` : "";
  const wt = e.worktree !== " " && e.worktree !== "?" ? `worktree: ${STATUS_LABEL[e.worktree] ?? e.worktree}` : "";
  return [staged, wt].filter(Boolean).join(" · ") || "—";
}

export function renderStatusCard(status: GitStatus): string {
  const lines: string[] = [`### Git · \`${status.branch || "(sem branch)"}\``];
  const sync: string[] = [];
  if (status.upstream) sync.push(`↑ upstream \`${status.upstream}\``);
  if (status.ahead) sync.push(`**${status.ahead}** à frente`);
  if (status.behind) sync.push(`**${status.behind}** atrás`);
  if (sync.length) lines.push("", sync.join(" · "));
  if (status.entries.length === 0) {
    lines.push("", "_Working tree limpo — nada a commitar._");
    return lines.join("\n");
  }
  lines.push("", "| arquivo | estado |", "|---|---|");
  for (const e of status.entries.slice(0, 50)) {
    const shown = e.origPath ? `${e.origPath} → ${e.path}` : e.path;
    lines.push(`| \`${shown}\` | ${fileLabel(e)} |`);
  }
  if (status.entries.length > 50) lines.push(`| … | e mais ${status.entries.length - 50} |`);
  const targets = commitTargets(status);
  lines.push("", `_${targets.length} arquivo(s) rastreado(s) entrariam num \`/git-commit\` (novos exigem \`git add\` antes)._`);
  return lines.join("\n");
}

export function renderDiffCard(diff: string, cap = 24000): string {
  const trimmed = diff.trim();
  if (!trimmed) return "### Git · diff\n\n_Sem alterações vs. `HEAD` (working tree limpo)._";
  const body = trimmed.length > cap ? trimmed.slice(0, cap) + "\n… (diff truncado)" : trimmed;
  return "### Git · diff (vs `HEAD`)\n\n```diff\n" + body + "\n```";
}

export interface GitCommit {
  hash: string;
  author: string;
  when: string;
  subject: string;
}
export function parseLog(output: string): GitCommit[] {
  const out: GitCommit[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line) continue;
    const [hash, author, when, subject] = line.split(LOG_SEP);
    if (hash) out.push({ hash, author: author ?? "", when: when ?? "", subject: subject ?? "" });
  }
  return out;
}
export function renderLogCard(commits: GitCommit[]): string {
  if (commits.length === 0) return "### Git · log\n\n_Sem commits._";
  const lines = ["### Git · log", "", "| commit | autor | quando | assunto |", "|---|---|---|---|"];
  for (const c of commits) lines.push(`| \`${c.hash}\` | ${c.author} | ${c.when} | ${c.subject.replace(/\|/g, "\\|")} |`);
  return lines.join("\n");
}

export function renderCommitResult(ok: boolean, output: string): string {
  const body = output.trim().slice(0, 2000);
  return ok
    ? "### Git · commit\n\n✅ Commit criado.\n\n```\n" + body + "\n```"
    : "### Git · commit\n\n❌ Falhou.\n\n```\n" + body + "\n```";
}

// Erro de uma operação de git (leitura ou commit) — o cabeçalho nomeia a operação CERTA (antes os erros
// de status/diff/log reusavam o card de "commit", que mentia sobre a ação).
const OP_LABEL: Record<GitOp, string> = { status: "status", diff: "diff", log: "log", commit: "commit" };
export function renderGitError(op: GitOp, output: string): string {
  const msg = output.trim().slice(0, 2000) || "git indisponível ou esta pasta não é um repositório.";
  return `### Git · ${OP_LABEL[op]}\n\n❌ ${msg}`;
}
