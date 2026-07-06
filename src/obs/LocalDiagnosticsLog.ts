import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ObsEvent } from "./types";
import { DiagnosticRecord, toDiagnosticRecord } from "./diagnostics";

// Sink de diagnóstico LOCAL (P3): recebe TODO ObsEvent e (1) guarda num ring buffer em memória — a fonte
// do bundle da sessão atual — e (2) faz append num NDJSON em globalStorage (best-effort, persiste entre
// execuções). SEMPRE-LIGADO (independente do opt-in do Langfuse) e SEMPRE REDIGIDO em modo `masked` (o
// bundle é um artefato compartilhável — nunca captura conteúdo cru). Fail-open: nenhum erro daqui pode
// quebrar a geração. Ver Observability (tee antes do gate de egress) e Controller.exportDiagnostics.
export class LocalDiagnosticsLog {
  private readonly ring: DiagnosticRecord[] = [];
  private readonly cap = 3000; // teto do buffer em memória (descarta o mais antigo)
  private dirEnsured = false;

  constructor(
    private readonly dir: string, // <globalStorage>/logs
    private readonly sessionId: () => string,
    private readonly opts: { enabled: () => boolean; now: () => string }
  ) {}

  write(e: ObsEvent): void {
    // TODO o corpo é fail-open: este write() roda no tee de Observability ANTES do sink do Langfuse, então
    // um throw aqui (inclusive em enabled()/now()) pularia o caminho remoto. Garantidamente não-lançante.
    try {
      if (!this.opts.enabled()) return;
      // SEMPRE masked: o bundle é compartilhável; nunca herda um `full` da config do Langfuse.
      const rec = toDiagnosticRecord(e, this.opts.now(), "masked");
      this.ring.push(rec);
      if (this.ring.length > this.cap) this.ring.shift();
      void this.append(rec); // fire-and-forget; erros engolidos no próprio append
    } catch {
      // diagnóstico nunca quebra a geração nem o caminho remoto de observabilidade
    }
  }

  // Snapshot do buffer em memória (a sessão atual) — fonte do bundle.
  records(): DiagnosticRecord[] {
    return [...this.ring];
  }

  private async append(rec: DiagnosticRecord): Promise<void> {
    try {
      if (!this.dirEnsured) {
        await fs.mkdir(this.dir, { recursive: true });
        this.dirEnsured = true;
      }
      await fs.appendFile(path.join(this.dir, `forge-${this.sessionId()}.ndjson`), JSON.stringify(rec) + "\n", "utf8");
    } catch {
      /* globalStorage indisponível/erro de I/O — o buffer em memória ainda serve o bundle */
    }
  }

  // Higiene: remove NDJSON de sessões antigas (best-effort) para não acumular em globalStorage. Chamado
  // uma vez na inicialização, espelhando o sweep de órfãos de validação já existente.
  async prune(maxAgeMs: number): Promise<void> {
    try {
      const cutoff = Date.parse(this.opts.now()) - maxAgeMs;
      for (const name of await fs.readdir(this.dir)) {
        if (!name.startsWith("forge-") || !name.endsWith(".ndjson")) continue;
        const p = path.join(this.dir, name);
        const st = await fs.stat(p).catch(() => null);
        if (st && st.mtimeMs < cutoff) await fs.rm(p, { force: true }).catch(() => undefined);
      }
    } catch {
      /* diretório ausente ainda / sem permissão — ignora */
    }
  }
}
