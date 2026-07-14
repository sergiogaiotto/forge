// Store dos SNAPSHOTS de schema do warehouse vivo: encapsula o ESTADO (índice por conexão, guard de
// load-once, single-flight) e os INVARIANTES da carga/captura — extraído do Controller (god-object, #213)
// para uma unidade INJETÁVEL e TESTÁVEL. É o IRMÃO do DbtIndexStore (#212): getGroundingIndex funde os
// dois. O I/O de disco (readdir/readFile/mkdir/writeFile) e o diretório de persistência (globalStorage) são
// passados por acessor → PURO/testável (sem vscode/fs direto; o teste injeta um fs em memória e conta
// chamadas). As transformações são PURAS (parseSnapshot/serializeSnapshot/snapshotToIndex de schemaSnapshot)
// e entram direto — a fronteira de injeção é só o I/O, para que o FILTRO e o PARSE-SKIP fiquem DENTRO do
// store.
//
// INVARIANTES (o valor de extrair — a lógica sutil que merece unit test):
//  - LOAD-ONCE: o diretório é varrido atrás de snapshots persistidos UMA vez (guard `loaded` no finally,
//    independe do resultado — como o Controller original: "já varri", não "carreguei com sucesso").
//  - SINGLE-FLIGHT: indexes() concorrentes (várias propostas validando em paralelo) compartilham a MESMA
//    carga em vez de o 2º ver a lista VAZIA no meio da varredura (endurecimento sobre o #213/original).
//  - FILTRO: só `wh-schema-*.json` é lido/parseado (o globalStorage tem logs/, vetores de índice, etc.).
//  - PARSE-SKIP: um arquivo cujo parseSnapshot devolve null (JSON inválido/forma errada) é PULADO.
//  - PER-FILE RESILIENCE: um snapshot corrompido (readFile falho, JSON quebrado, linha sem `table` que faz
//    snapshotToIndex estourar) é IGNORADO e a carga SEGUE nos demais — um arquivo ruim não derruba todo o
//    grounding de warehouse da sessão (endurecimento sobre o #213/original, que abortava a carga inteira).
//  - CAPTURE sobrescreve-por-conexão: um novo /schema da mesma conexão substitui o índice anterior.
//  - PERSIST fail-closed + fail-open: connectionId inseguro (separador/'..') NÃO persiste (comporia caminho
//    fora do globalStorage; allowlist > denylist, #209); erro de escrita → segue em memória (log.warn).
//  - LOAD fail-open: readdir falho (dir inexistente no 1º run, o caso NORMAL) → vazio, SILENCIOSO.
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
// connectionId seguro para compor o nome do arquivo: sem separador de caminho (`/`,`\`) nem qualquer coisa
// que escape o diretório. Allowlist estrita (fail-closed) — connectionId é config do admin (não free-text).
const SAFE_CONN = /^[A-Za-z0-9._-]+$/;
const snapFile = (connectionId: string) => `wh-schema-${connectionId}.json`;

export class WarehouseSnapshotStore {
  private byConn = new Map<string, DbtIndex>();
  private loaded = false; // já varremos o diretório atrás de snapshots persistidos?
  private loading: Promise<void> | null = null; // single-flight (indexes() concorrentes compartilham)

  constructor(private readonly deps: WarehouseSnapshotStoreDeps) {}

  // Índices por conexão (carregados dos snapshots persistidos no 1º acesso, load-once + single-flight).
  // Alimenta o merge do grounding junto com o índice dbt. Fail-open: sem snapshots / erro de I/O → vazio.
  async indexes(): Promise<DbtIndex[]> {
    await this.ensureLoaded();
    return [...this.byConn.values()];
  }

  // Captura um snapshot vivo (montado pelo caller com o timestamp): converte em índice, SOBRESCREVE por
  // conexão e persiste no globalStorage. Devolve o índice para o caller montar o card (index.size()).
  async capture(snap: WarehouseSnapshot): Promise<DbtIndex> {
    const index = snapshotToIndex(snap);
    this.byConn.set(snap.connectionId, index);
    if (!SAFE_CONN.test(snap.connectionId)) {
      // Fail-closed: um connectionId com separador/'..' comporia um caminho FORA do globalStorage. Não
      // persiste (segue em memória nesta sessão) — allowlist > denylist (mesmo princípio do #209).
      this.deps.log.warn(`warehouse: snapshot não persistido — connectionId inseguro para nome de arquivo: ${JSON.stringify(snap.connectionId)}.`);
      return index;
    }
    try {
      const dir = this.deps.storageDir();
      await this.deps.fs.mkdir(dir);
      await this.deps.fs.writeFile(path.join(dir, snapFile(snap.connectionId)), serializeSnapshot(snap));
    } catch (err) {
      this.deps.log.warn("warehouse: snapshot não persistido (segue em memória).", err);
    }
    return index;
  }

  private ensureLoaded(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    if (this.loading) return this.loading; // single-flight: 1ªs chamadas concorrentes compartilham a carga
    this.loading = this.load().finally(() => {
      this.loaded = true; // "varri uma vez" (independe do resultado — como o Controller original)
      this.loading = null;
    });
    return this.loading;
  }

  private async load(): Promise<void> {
    const dir = this.deps.storageDir();
    // readdir falho (dir ainda não existe no 1º run) → vazio SILENCIOSO (é o caso normal, não um erro).
    for (const f of await this.deps.fs.readdir(dir).catch(() => [] as string[])) {
      if (!SNAP_RE.test(f)) continue;
      try {
        // PER-FILE: um snapshot corrompido (readFile falho, JSON quebrado, linha sem `table` que faz
        // snapshotToIndex estourar) é IGNORADO — a carga SEGUE nos demais (antes o erro abortava tudo e
        // perdia todo o grounding de warehouse da sessão por causa de um único arquivo ruim).
        const snap = parseSnapshot(await this.deps.fs.readFile(path.join(dir, f)));
        if (snap) this.byConn.set(snap.connectionId, snapshotToIndex(snap));
      } catch (err) {
        this.deps.log.warn(`warehouse: snapshot ${f} ignorado (fail-open).`, err);
      }
    }
  }
}
