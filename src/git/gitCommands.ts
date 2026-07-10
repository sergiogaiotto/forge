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
      return ["--no-pager", "diff", "HEAD"];
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
      status.entries.push({ index: line[0], worktree: line[1], path: line.slice(3) });
    }
  }
  return status;
}

// Arquivos que um `git commit -a` REALMENTE incluiria: rastreados com modificação no worktree (M/D) ou
// já staged (index != ' ' e != '?'). Untracked ('??') NÃO entram. É a lista mostrada na confirmação —
// o dev vê exatamente o que será selado antes de confirmar.
export function commitTargets(status: GitStatus): string[] {
  const out: string[] = [];
  for (const e of status.entries) {
    if (e.index === "?" && e.worktree === "?") continue; // untracked
    const staged = e.index !== " " && e.index !== "?";
    const worktreeModified = e.worktree === "M" || e.worktree === "D";
    if (staged || worktreeModified) out.push(e.path);
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
  for (const e of status.entries.slice(0, 50)) lines.push(`| \`${e.path}\` | ${fileLabel(e)} |`);
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
