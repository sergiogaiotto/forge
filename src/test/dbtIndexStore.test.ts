import assert from "node:assert/strict";
import { test } from "node:test";
import { DbtIndexStore, DbtIndexStoreDeps } from "../dbt/DbtIndexStore";

// Fakes mínimos: o store só usa `.size()` do índice (no log) e `.location.{projectDir,targetDir}` do loaded.
const fakeIndex = (n = 1) => ({ size: () => n }) as any;
const LOC = { projectDir: "/ws/proj", targetDir: "/ws/proj/target" } as any;
const loaded = (idx: any) => ({ index: idx, location: LOC }) as any;
const noLog = { info: () => undefined, warn: () => undefined };

function makeDeps(over: Partial<DbtIndexStoreDeps> = {}): DbtIndexStoreDeps {
  return {
    workspaceRoot: () => "/ws",
    findDbtProject: async () => LOC,
    loadDbtIndex: async () => loaded(fakeIndex()),
    isStale: async () => false,
    log: noLog,
    ...over,
  };
}

test("DbtIndexStore: PROBE-ONCE — findDbtProject roda uma vez; índice fresco não recarrega", async () => {
  let probes = 0,
    loads = 0;
  const store = new DbtIndexStore(
    makeDeps({
      findDbtProject: async () => (probes++, LOC),
      loadDbtIndex: async () => (loads++, loaded(fakeIndex())),
      isStale: async () => false,
    })
  );
  assert.ok(await store.get());
  assert.ok(await store.get());
  assert.equal(probes, 1, "varre o workspace só uma vez");
  assert.equal(loads, 1, "índice fresco → não recarrega no 2º get");
});

test("DbtIndexStore: SINGLE-FLIGHT — gets concorrentes compartilham a MESMA carga", async () => {
  let loads = 0;
  let open!: (v: unknown) => void;
  const gate = new Promise((r) => (open = r));
  const store = new DbtIndexStore(makeDeps({ loadDbtIndex: async () => (loads++, await gate, loaded(fakeIndex())) }));
  const p1 = store.get();
  const p2 = store.get(); // concorrente, ANTES do 1º resolver
  open(null);
  const [a, b] = await Promise.all([p1, p2]);
  assert.equal(loads, 1, "uma só carga para os dois gets concorrentes");
  assert.equal(a, b, "a mesma Promise/índice");
});

test("DbtIndexStore: RELOAD-POR-STALENESS — stale recarrega; fresco não", async () => {
  let loads = 0;
  let stale = false;
  const store = new DbtIndexStore(makeDeps({ loadDbtIndex: async () => (loads++, loaded(fakeIndex())), isStale: async () => stale }));
  await store.get();
  assert.equal(loads, 1);
  await store.get(); // fresco → não recarrega
  assert.equal(loads, 1);
  stale = true;
  await store.get(); // stale → recarrega
  assert.equal(loads, 2);
});

test("DbtIndexStore: sem workspace → undefined (não sonda nem carrega)", async () => {
  let probes = 0;
  const store = new DbtIndexStore(makeDeps({ workspaceRoot: () => undefined, findDbtProject: async () => (probes++, LOC) }));
  assert.equal(await store.get(), undefined);
  assert.equal(probes, 0);
});

test("DbtIndexStore: sem projeto dbt (findDbtProject null) → undefined; probe-once mesmo assim", async () => {
  let probes = 0;
  const store = new DbtIndexStore(makeDeps({ findDbtProject: async () => (probes++, null) }));
  assert.equal(await store.get(), undefined);
  assert.equal(await store.get(), undefined);
  assert.equal(probes, 1, "não re-sonda o resto da sessão (probed=true)");
});

test("DbtIndexStore: FAIL-OPEN — exceção no probe/load → undefined (não trava a geração)", async () => {
  const s1 = new DbtIndexStore(makeDeps({ findDbtProject: async () => { throw new Error("boom"); } }));
  assert.equal(await s1.get(), undefined);
  const s2 = new DbtIndexStore(makeDeps({ loadDbtIndex: async () => { throw new Error("boom"); } }));
  assert.equal(await s2.get(), undefined);
});

test("DbtIndexStore: RE-TENTA da localização conhecida — manifest criado DEPOIS do probe (sem re-sondar)", async () => {
  let probes = 0,
    loads = 0;
  const idx = fakeIndex(3);
  const store = new DbtIndexStore(
    makeDeps({
      findDbtProject: async () => (probes++, LOC),
      loadDbtIndex: async () => (loads++, loads === 1 ? null : loaded(idx)), // 1º sem manifest; 2º já existe
    })
  );
  assert.equal(await store.get(), undefined, "1º get: sem manifest ainda");
  assert.equal(await store.get(), idx, "2º get: manifest apareceu → índice carregado");
  assert.equal(probes, 1, "não re-sondou (probe-once)");
  assert.equal(loads, 2, "re-tentou o load da localização conhecida");
});

test("DbtIndexStore: projectDir() reflete a localização carregada", async () => {
  const store = new DbtIndexStore(makeDeps());
  assert.equal(store.projectDir(), undefined, "antes do load");
  await store.get();
  assert.equal(store.projectDir(), "/ws/proj");
});
