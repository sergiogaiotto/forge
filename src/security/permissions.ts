// Permission model UNIFICADO (Fase 4 do hardening). As decisões de permissão do FORGE aconteciam em
// 4 superfícies ad-hoc (aprovação de ferramenta MCP, confirmação de escrita SQL em DOIS modais
// duplicados, o "Aplicar assim mesmo, revisei" do gate e a confirmação de contrato do Modo Projeto),
// cada uma com prompt e auditoria próprios — a maioria invisível na observabilidade. Este módulo
// centraliza: UM pipeline de decisão (puro), UM prompter injetável e UM trail de auditoria que também
// vira evento obs (`permission.decision`) — visível no Langfuse pelos sinks existentes.
// PURO (sem vscode): o diálogo nativo é injetado pelo Controller; testável de ponta a ponta.

export type PermissionKind =
  | "mcp.tool"
  | "sql.write"
  | "sql.analyze"
  | "proposal.force"
  | "contract.unverified"
  | "env.dependency"
  | "git.commit";
export type PermissionOutcome = "auto" | "approved" | "denied" | "blocked";
// Por onde a decisão foi tomada: "policy" (bloqueio do admin, sem prompt), "auto" (auto-approve
// somente-leitura), "dialog" (modal nativo do host) ou "webview" (botão/card do painel).
export type PermissionVia = "policy" | "auto" | "dialog" | "webview";

export interface PermissionRequest {
  kind: PermissionKind;
  // Frase curta do que será permitido (vira o título do modal e o `action` do registro).
  action: string;
  // Alvo da ação (id da conexão, servidor.tool, caminho do arquivo) — para filtrar na auditoria.
  subject?: string;
  scope: "read" | "write";
  // Prévia do conteúdo (SQL, args, arquivo) — SEMPRE capada antes de registrar/exibir.
  detail?: string;
}

export interface PermissionRecord {
  kind: PermissionKind;
  action: string;
  subject?: string;
  scope: "read" | "write";
  outcome: PermissionOutcome;
  via: PermissionVia;
  detail?: string;
  ts: number;
}

// Pipeline de decisão puro. Precedência: bloqueio de POLÍTICA (nunca pergunta — não existe escape) >
// auto-approve (SÓ leitura — escrita jamais é auto-aprovada, mesma regra do ToolApprovalGate/RF-075) >
// perguntar ao dev.
export function resolvePermission(opts: { policyBlocked?: boolean; autoApprove?: boolean; scope: "read" | "write" }): "block" | "auto" | "ask" {
  if (opts.policyBlocked) return "block";
  if (opts.autoApprove && opts.scope === "read") return "auto";
  return "ask";
}

// Prévia segura de um valor arbitrário (generaliza o previewArgs do ToolApprovalGate).
export function previewDetail(value: unknown, cap = 600): string {
  try {
    const s = typeof value === "string" ? value : JSON.stringify(value);
    return s.length > cap ? s.slice(0, cap) + "…" : s;
  } catch {
    return String(value);
  }
}

// Trail central de decisões (generalização do McpAuditor, que segue registrando o RESULTADO das
// chamadas MCP — aqui ficam as DECISÕES de permissão de todas as superfícies).
export class PermissionAuditor {
  private readonly ring: PermissionRecord[] = [];
  private readonly max = 500;

  record(rec: Omit<PermissionRecord, "ts">): PermissionRecord {
    const full: PermissionRecord = { ...rec, ts: Date.now() };
    this.ring.push(full);
    if (this.ring.length > this.max) this.ring.shift();
    return full;
  }

  recent(): PermissionRecord[] {
    return [...this.ring];
  }
}

// Diálogo de confirmação injetado (o Controller liga ao vscode.window.showWarningMessage modal).
// Retorna o rótulo clicado ou undefined (cancelado).
export type PermissionDialog = (message: string, detail: string, confirmLabel: string) => Promise<string | undefined>;

export class PermissionService {
  constructor(
    private readonly auditor: PermissionAuditor,
    // Hook de observabilidade: o Controller emite o `permission.decision` (Langfuse + diagnóstico local)
    // para CADA registro.
    private readonly emit: (rec: PermissionRecord) => void,
    private readonly dialog: PermissionDialog,
    // Log imediato de cada decisão (output channel do FORGE) — consumidor síncrono do trail, paridade com
    // o McpAuditor. Injetado (o módulo é puro). Default noop.
    private readonly logInfo: (msg: string) => void = () => undefined
  ) {}

  // Registra uma decisão tomada em OUTRA superfície (card webview do MCP, botão "Aplicar assim mesmo",
  // bloqueio de política já aplicado) — mantém o trail único sem forçar todas as UX para o modal.
  note(req: PermissionRequest, outcome: PermissionOutcome, via: PermissionVia): void {
    const rec = this.auditor.record({ ...req, detail: req.detail ? previewDetail(req.detail) : undefined, outcome, via });
    this.logInfo(`[permissão] ${rec.kind} ${rec.scope} · ${rec.action} → ${rec.outcome} (${rec.via})`);
    this.emit(rec);
  }

  // Fluxo completo: decide (política/auto/perguntar), pergunta pelo diálogo nativo quando preciso,
  // registra o desfecho e devolve permitido/negado.
  async confirm(
    req: PermissionRequest,
    opts?: { policyBlocked?: boolean; autoApprove?: boolean; confirmLabel?: string }
  ): Promise<boolean> {
    const resolved = resolvePermission({ policyBlocked: opts?.policyBlocked, autoApprove: opts?.autoApprove, scope: req.scope });
    if (resolved === "block") {
      this.note(req, "blocked", "policy");
      return false;
    }
    if (resolved === "auto") {
      this.note(req, "auto", "auto");
      return true;
    }
    const label = opts?.confirmLabel ?? "Permitir";
    const pick = await this.dialog(`FORGE · ${req.action}`, previewDetail(req.detail ?? ""), label);
    const ok = pick === label;
    this.note(req, ok ? "approved" : "denied", "dialog");
    return ok;
  }
}
