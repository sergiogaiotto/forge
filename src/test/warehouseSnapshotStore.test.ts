import assert from "node:assert/strict";
import { test } from "node:test";
import { WarehouseSnapshotStore, WarehouseSnapshotStoreDeps } from "../warehouse/WarehouseSnapshotStore";
import { serializeSnapshot, SchemaSnapshotRow, WarehouseSnapshot } from "../warehouse/schemaSnapshot";

// fs em memória: os arquivos são indexados por BASENAME; o store passa caminhos completos (path.join com
// o storageDir), então readFile/writeFile extraem o basename (tolera `\` do win32 e `/`).
const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
function memFs(files: Record<string, string> = {}) {
  const store: Record<string, string> = { ...files };
  const calls = { readdir: 0, mkdir: 0, reads: [] as string[], writes: [] as Array<{ file: string; content: string }> };
  const fs = {
    readdir: async (_dir: string) => (calls.readdir++, Object.keys(store)),
    readFile: async (file: string) => {
      const b = base(file);
      calls.reads.push(b);
      if (!(b in store)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return store[b];
    },
    mkdir: async (_dir: string) => void calls.mkdir++,
    writeFile: async (file: string, content: string) => {
      const b = base(file);
      store[b] = content;
      calls.writes.push({ file: b, content });
    },
  };
  return { store, calls, fs };
}

const ROWS: SchemaSnapshotRow[] = [
  { table: "public.orders", column: "id", type: "int" },
  { table: "public.orders", column: "total", type: "numeric" },
];
const snap = (id: string, rows: SchemaSnapshotRow[] = ROWS): WarehouseSnapshot => ({ connectionId: id, kind: "postgres", takenAt: "2026-01-01T00:00:00Z", rows });

function makeStore(over: { files?: Record<string, string>; fsOver?: Partial<WarehouseSnapshotStoreDeps["fs"]> } = {}) {
  const warns: Array<{ m: string; e?: unknown }> = [];
  const mem = memFs(over.files);
  const fs = { ...mem.fs, ...(over.fsOver ?? {}) };
  const store = new WarehouseSnapshotStore({ storageDir: () => "/gs", fs, log: { warn: (m, e) => warns.push({ m, e }) } });
  return { store, warns, calls: mem.calls, mem: mem.store };
}

test("WarehouseSnapshotStore: LOAD-ONCE — varre o dir uma vez mesmo em N chamadas de indexes()", async () => {
  const { store, calls } = makeStore({ files: { "wh-schema-a.json": serializeSnapshot(snap("a")) } });
  const a = await store.indexes();
  const b = await store.indexes();
  assert.equal(calls.readdir, 1, "readdir uma única vez (guard load-once)");
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.equal(a[0], b[0], "o mesmo índice em cache");
});

test("WarehouseSnapshotStore: FILTRO — só wh-schema-*.json é lido/parseado", async () => {
  const { store, calls } = makeStore({
    files: {
      "wh-schema-prod.json": serializeSnapshot(snap("prod")),
      "index.bin": "vetores...",
      "logs": "não é json",
      "outra.json": JSON.stringify({ connectionId: "x", kind: "postgres", takenAt: "", rows: [] }),
    },
  });
  const idx = await store.indexes();
  assert.equal(idx.length, 1, "só a conexão do wh-schema-*.json");
  assert.deepEqual(calls.reads, ["wh-schema-prod.json"], "os outros arquivos nem são lidos");
});

test("WarehouseSnapshotStore: PARSE-SKIP — arquivo com JSON inválido é pulado; os válidos carregam", async () => {
  const { store, warns } = makeStore({
    files: {
      "wh-schema-bad.json": "{ isto não é json",
      "wh-schema-ok.json": serializeSnapshot(snap("ok")),
    },
  });
  const idx = await store.indexes();
  assert.equal(idx.length, 1, "o inválido (parseSnapshot=null) é pulado; o válido entra");
  assert.equal(warns.length, 0, "JSON inválido não é erro: parseSnapshot devolve null, não estoura");
});

test("WarehouseSnapshotStore: LOAD fail-open — readdir falho → vazio e SILENCIOSO (dir inexistente no 1º run)", async () => {
  const { store, warns } = makeStore({ fsOver: { readdir: async () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); } } });
  assert.deepEqual(await store.indexes(), [], "sem snapshots");
  assert.equal(warns.length, 0, "o caso normal (dir ainda não existe) não gera ruído");
});

test("WarehouseSnapshotStore: LOAD fail-open — readFile que estoura loga e não trava", async () => {
  const { store, warns } = makeStore({
    files: { "wh-schema-a.json": serializeSnapshot(snap("a")) },
    fsOver: { readFile: async () => { throw new Error("EIO"); } },
  });
  assert.deepEqual(await store.indexes(), [], "carga abortada, fail-open");
  assert.equal(warns.length, 1, "logou o fail-open da carga");
  assert.match(warns[0].m, /não carregados/);
});

test("WarehouseSnapshotStore: CAPTURE — converte, devolve o índice e persiste (mkdir+writeFile)", async () => {
  const { store, calls, mem } = makeStore();
  const idx = await store.capture(snap("conn1"));
  assert.equal(idx.size(), 1, "uma tabela (public.orders) no índice");
  assert.equal(calls.mkdir, 1, "garante o diretório");
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0].file, "wh-schema-conn1.json", "nome do arquivo por conexão");
  assert.ok(mem["wh-schema-conn1.json"], "persistido");
});

test("WarehouseSnapshotStore: CAPTURE popula o mapa em memória — visível sem re-ler o disco", async () => {
  const { store, calls } = makeStore();
  await store.indexes(); // dispara o load-once (dir vazio) → loaded=true
  assert.equal(calls.readdir, 1);
  const idx = await store.capture(snap("c"));
  const listed = await store.indexes(); // loaded=true → NÃO re-varre o disco
  assert.equal(calls.readdir, 1, "não re-varreu (o índice veio direto da memória)");
  assert.equal(listed.length, 1);
  assert.equal(listed[0], idx, "o MESMO índice em memória (sem round-trip de disco)");
});

test("WarehouseSnapshotStore: CAPTURE sobrescreve por conexão — 2º /schema da mesma conn substitui", async () => {
  const { store } = makeStore();
  await store.indexes(); // loaded=true antes, p/ isolar a semântica de memória do reload de disco
  await store.capture(snap("c", [{ table: "s.a", column: "x" }]));
  const idx2 = await store.capture(snap("c", [{ table: "s.b", column: "y" }, { table: "s.c", column: "z" }]));
  const listed = await store.indexes();
  assert.equal(listed.length, 1, "uma só entrada para a conexão (sobrescreveu)");
  assert.equal(listed[0], idx2, "reflete a captura mais recente");
  assert.equal(idx2.size(), 2, "as tabelas da 2ª captura");
});

test("WarehouseSnapshotStore: capture-antes-do-load-once re-lê do disco no 1º indexes() (pega snapshots de sessões antigas)", async () => {
  // Sessão nova com um snapshot PERSISTIDO por sessão anterior (conn 'old'); o dev roda /schema em 'new'
  // ANTES de qualquer grounding. O 1º indexes() DEVE trazer os DOIS — o capture não pode "trancar" o load.
  const { store } = makeStore({ files: { "wh-schema-old.json": serializeSnapshot(snap("old")) } });
  await store.capture(snap("new"));
  const listed = await store.indexes();
  assert.equal(listed.length, 2, "capture não impede o load-once de carregar snapshots de sessões anteriores");
});

test("WarehouseSnapshotStore: PERSIST fail-open — writeFile estoura → segue em memória e loga", async () => {
  const { store, warns } = makeStore({ fsOver: { writeFile: async () => { throw new Error("ENOSPC"); } } });
  const idx = await store.capture(snap("c"));
  assert.equal(idx.size(), 1, "o índice é devolvido apesar da falha de escrita");
  assert.equal((await store.indexes())[0], idx, "mantido em memória");
  assert.equal(warns.length, 1);
  assert.match(warns[0].m, /não persistido/);
});

test("WarehouseSnapshotStore: ROUND-TRIP persist→load — outro store lê o arquivo e reconstrói o índice", async () => {
  const first = makeStore();
  await first.store.capture(snap("prod"));
  const persisted = first.mem["wh-schema-prod.json"]; // o que foi realmente escrito no disco fake

  // Um novo store (nova sessão) apontando para o mesmo "disco" carrega o snapshot persistido.
  const second = makeStore({ files: { "wh-schema-prod.json": persisted } });
  const idx = await second.store.indexes();
  assert.equal(idx.length, 1);
  assert.equal(idx[0].size(), 1, "reconstruiu a tabela public.orders");
  assert.ok(idx[0].findTable("public.orders"), "a tabela do snapshot voltou pelo round-trip serialize/parse");
});
