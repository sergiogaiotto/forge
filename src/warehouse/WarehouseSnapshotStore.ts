// Store dos SNAPSHOTS de schema do warehouse vivo: encapsula o ESTADO (índice por conexão, guard de
// load-once) e os INVARIANTES da carga/captura — extraído do Controller (god-object) para uma unidade
// INJETÁVEL e TESTÁVEL. É o IRMÃO do DbtIndexStore (#212): getGroundingIndex funde os dois. O I/O de
// disco (readdir/readFile/mkdir/writeFile) e o diretório de persistência (globalStorage) são passados por
// acessor → PURO/testável (sem vscode/fs direto; o teste injeta um fs em memória e conta chamadas). As
// transformações são PURAS (parseSnapshot/serializeSnapshot/snapshotToIndex de schemaSnapshot) e entram
// direto — a fronteira de injeção é só o I/O, para que o FILTRO e o PARSE-SKIP fiquem DENTRO do store.
//
// INVARIANTES (o valor de extrair — a lógica sutil que merece unit test):
//  - LOAD-ONCE: o diretório é varrido atrás de snapshots persistidos UMA vez; o guard é setado ANTES do
//    await, então mesmo em erro não re-varre (paridade byte-a-byte com o Controller).
//  - FILTRO: só `wh-schema-*.json` é lido/parseado (o globalStorage tem logs/, vetores de índice, etc.).
//  - PARSE-SKIP: um arquivo cujo parseSnapshot devolve null (JSON inválido/forma errada) é PULADO.
//  - CAPTURE sobrescreve-por-conexão: um novo /schema da mesma conexão substitui o índice anterior.
//  - PERSIST fail-open: erro de escrita → segue em memória (log.warn, sem throw) — o /schema não falha.
//  - LOAD fail-open: readdir falho (dir inexistente no 1º run — o caso NORMAL) → vazio, SILENCIOSO; um
//    readFile/parse que estoura aborta a carga e loga (fail-open) — nada trava a geração por grounding.
import * as path from "node:path";
import { DbtIndex } from "../dbt/artifacts";
import { parseSnapshot, serializeSnapshot, snapshotToIndex, WarehouseSnapshot } from "./schemaSnapshot";

export interface WarehouseSnapshotStoreDeps {
  storageDir: () => string; // diretório de persistência (globalStorage) — acessor lazy (ctor do Controller)
  fs: {
    readdir: (dir: string) => Promise<string[]>;
    readFile: (file: string) => Promise<string>;
    mkdir: (dir: string) => Promise<void>; // o adapter do Controller passa { recursive: true }
    writeFile: (file: string, content: string) => Promise<void>; // o adapter passa "utf8"
  };
  log: { warn: (m: string, e?: unknown) => void };
}

const SNAP_RE = /^wh-schema-.+\.json$/;
const snapFile = (connectionId: string) => `wh-schema-${connectionId}.json`;

export class WarehouseSnapshotStore {
  private byConn = new Map<string, DbtIndex>();
  private loaded = false; // já varremos o diretório atrás de snapshots persistidos?

  constructor(private readonly deps: WarehouseSnapshotStoreDeps) {}

  // Índices por conexão (carregados dos snapshots persistidos no 1º acesso, load-once). Alimenta o merge
  // do grounding junto com o índice dbt. Fail-open: sem snapshots / erro de I/O → lista vazia.
  async indexes(): Promise<DbtIndex[]> {
    await this.ensureLoaded();
    return [...this.byConn.values()];
  }

  // Captura um snapshot vivo (montado pelo caller com o timestamp): converte em índice, SOBRESCREVE por
  // conexão e persiste no globalStorage. Fail-open na escrita (segue em memória). Devolve o índice para o
  // caller montar o card (index.size()).
  async capture(snap: WarehouseSnapshot): Promise<DbtIndex> {
    const index = snapshotToIndex(snap);
    this.byConn.set(snap.connectionId, index);
    try {
      const dir = this.deps.storageDir();
      await this.deps.fs.mkdir(dir);
      await this.deps.fs.writeFile(path.join(dir, snapFile(snap.connectionId)), serializeSnapshot(snap));
    } catch (err) {
      this.deps.log.warn("warehouse: snapshot não persistido (segue em memória).", err);
    }
    return index;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true; // ANTES do await: mesmo em erro, não re-varre (paridade com o Controller)
    try {
      const dir = this.deps.storageDir();
      // readdir falho (dir ainda não existe no 1º run) → vazio SILENCIOSO (é o caso normal, não um erro);
      // readFile/parse que estoura cai no catch externo (log.warn) — aborta a carga, mas não trava nada.
      for (const f of await this.deps.fs.readdir(dir).catch(() => [] as string[])) {
        if (!SNAP_RE.test(f)) continue;
        const snap = parseSnapshot(await this.deps.fs.readFile(path.join(dir, f)));
        if (snap) this.byConn.set(snap.connectionId, snapshotToIndex(snap));
      }
    } catch (err) {
      this.deps.log.warn("warehouse: snapshots não carregados (fail-open).", err);
    }
  }
}
