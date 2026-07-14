// Store do índice de GROUNDING dbt: encapsula o ESTADO (índice carregado, se o workspace já foi varrido, a
// localização do projeto, o guard de single-flight) e os INVARIANTES da carga — extraído do Controller (god-
// object) para uma unidade INJETÁVEL e TESTÁVEL. O I/O do dbt (findDbtProject/loadDbtIndex/dbtIndexStale) e o
// workspaceRoot são passados por acessor (como ProviderRuntimeResolver/SessionBudget/AttachmentStore, #195-#197)
// → PURO/testável (sem vscode/fs direto; o teste injeta mocks e conta chamadas).
//
// INVARIANTES (o valor de extrair — a lógica sutil que merece unit test):
//  - SINGLE-FLIGHT: chamadas concorrentes (várias propostas validando em paralelo) compartilham a MESMA Promise,
//    em vez de recarregar em duplicidade ou verem "sem grounding" durante o probe.
//  - PROBE-ONCE: o workspace é varrido atrás de dbt_project.yml UMA vez (findDbtProject); nunca re-varre.
//  - RELOAD-POR-STALENESS: índice fresco → cache; stale (mtime mudou) → recarrega da localização conhecida.
//    Cobre o 1º load, a recarga por staleness E o "manifest criado DEPOIS do probe" (custo: um fs.stat).
//  - FAIL-OPEN: sem workspace / sem projeto dbt / exceção → undefined (nada trava a geração por falta de grounding).
import { DbtIndex } from "./artifacts";
import { DbtProjectLocation, LoadedDbtIndex } from "./loader";

export interface DbtIndexStoreDeps {
  workspaceRoot: () => string | undefined;
  findDbtProject: (ws: string) => Promise<DbtProjectLocation | null>;
  loadDbtIndex: (loc: DbtProjectLocation, warn: (m: string, e?: unknown) => void) => Promise<LoadedDbtIndex | null>;
  isStale: (loaded: LoadedDbtIndex) => Promise<boolean>;
  log: { info: (m: string) => void; warn: (m: string, e?: unknown) => void };
}

export class DbtIndexStore {
  private loaded: LoadedDbtIndex | null = null;
  private probed = false; // já varremos o workspace atrás de dbt_project.yml? (só isso — nunca "desisti do manifest")
  private location: DbtProjectLocation | null = null;
  private inflight: Promise<DbtIndex | undefined> | null = null; // single-flight (propostas chegam em paralelo)

  constructor(private readonly deps: DbtIndexStoreDeps) {}

  // Índice dos artefatos dbt do workspace, com recarga por mtime. undefined = sem grounding. Single-flight:
  // concorrentes compartilham a mesma Promise em vez de recarregar em duplicidade ou verem "sem grounding".
  get(): Promise<DbtIndex | undefined> {
    if (this.inflight) return this.inflight;
    this.inflight = this.load().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  // Diretório do projeto dbt carregado (para resolver caminhos relativos de modelo no /impacto). undefined
  // antes do 1º load ou sem projeto dbt.
  projectDir(): string | undefined {
    return this.loaded?.location.projectDir;
  }

  private async load(): Promise<DbtIndex | undefined> {
    const ws = this.deps.workspaceRoot();
    if (!ws) return undefined;
    try {
      if (this.loaded && !(await this.deps.isStale(this.loaded))) return this.loaded.index;
      if (!this.probed) {
        this.probed = true; // significa só "já varri o workspace atrás de dbt_project.yml"
        this.location = await this.deps.findDbtProject(ws);
      }
      if (!this.location) return undefined; // não há projeto dbt — nada a fazer nesta sessão
      // (Re)carrega da localização conhecida: cobre o primeiro load, a recarga por staleness E o "rode dbt
      // parse e tente de novo" (manifest criado DEPOIS do probe). Custo: um fs.stat.
      const before = this.loaded?.index;
      this.loaded = await this.deps.loadDbtIndex(this.location, (m, e) => this.deps.log.warn(m, e));
      if (this.loaded && this.loaded.index !== before) {
        this.deps.log.info(`dbt: grounding ativo — ${this.loaded.index.size()} tabelas do manifest (${this.loaded.location.targetDir}).`);
      }
      return this.loaded?.index;
    } catch (err) {
      this.deps.log.warn("dbt: grounding indisponível (fail-open).", err);
      return undefined;
    }
  }
}
