import assert from "node:assert/strict";
import { test } from "node:test";
import type { BlueprintFile } from "../shared/protocol";
import { normRepairPath, selectRepairTargets } from "../core/projectRepair";

const bp = (path: string, deps: string[] = []): BlueprintFile => ({ path, purpose: "", deps });

test("normRepairPath: barras pra frente, sem ./ nem / inicial", () => {
  assert.equal(normRepairPath("src\\app\\create_order.py"), "src/app/create_order.py");
  assert.equal(normRepairPath("./src/app.py"), "src/app.py");
  assert.equal(normRepairPath("/src/app.py"), "src/app.py");
});

test("selectRepairTargets: injeta o CONTEÚDO REAL dos deps que PASSARAM como contrato", () => {
  const content = new Map([
    ["src/domain/entities.py", "class Order:\n    id: OrderId"],
    ["src/domain/value_objects.py", "OrderId = UUID"],
    ["src/app/create_order.py", "from src.domain.entities import OrderStatus"],
  ]);
  const blueprint = [bp("src/domain/entities.py"), bp("src/domain/value_objects.py"), bp("src/app/create_order.py", ["src/domain/entities.py", "src/domain/value_objects.py"])];
  const targets = selectRepairTargets(
    [{ path: "src/app/create_order.py", errors: ["linha 1: has no attribute OrderStatus"] }],
    content,
    blueprint
  );
  assert.equal(targets.length, 1);
  assert.equal(targets[0].path, "src/app/create_order.py");
  assert.deepEqual(targets[0].errors, ["linha 1: has no attribute OrderStatus"]);
  assert.deepEqual(
    targets[0].contracts.map((c) => c.path),
    ["src/domain/entities.py", "src/domain/value_objects.py"]
  );
  assert.match(targets[0].contracts[0].content, /class Order/);
});

test("selectRepairTargets: um dep que TAMBÉM reprovou NÃO vira contrato (não é confiável)", () => {
  const content = new Map([
    ["src/domain/entities.py", "class Order:\n    id: OrderId"], // passou
    ["src/domain/repositories.py", "class OrderRepository: ..."], // TAMBÉM reprovou
    ["src/app/create_order.py", "..."],
  ]);
  const blueprint = [bp("src/app/create_order.py", ["src/domain/entities.py", "src/domain/repositories.py"])];
  const targets = selectRepairTargets(
    [
      { path: "src/app/create_order.py", errors: ["e1"] },
      { path: "src/domain/repositories.py", errors: ["e2"] },
    ],
    content,
    blueprint
  );
  const createOrder = targets.find((t) => t.path === "src/app/create_order.py")!;
  assert.deepEqual(createOrder.contracts.map((c) => c.path), ["src/domain/entities.py"]); // repositories (reprovado) fora
});

test("selectRepairTargets: sem deps declaradas → fallback usa TODOS os arquivos que passaram", () => {
  const content = new Map([
    ["src/domain/entities.py", "class Order: ..."],
    ["src/app/create_order.py", "..."],
  ]);
  const blueprint = [bp("src/app/create_order.py", [])]; // sem deps declaradas
  const targets = selectRepairTargets([{ path: "src/app/create_order.py", errors: ["e"] }], content, blueprint);
  assert.deepEqual(targets[0].contracts.map((c) => c.path), ["src/domain/entities.py"]);
});

test("selectRepairTargets: pula alvo sem proposta ou sem erro (nada a reparar)", () => {
  const content = new Map([["a.py", "x"]]);
  const semProposta = selectRepairTargets([{ path: "sumiu.py", errors: ["e"] }], content, []);
  assert.equal(semProposta.length, 0);
  const semErro = selectRepairTargets([{ path: "a.py", errors: [] }], content, []);
  assert.equal(semErro.length, 0);
});

test("selectRepairTargets: respeita os tetos de contratos e de tamanho", () => {
  const big = "y".repeat(9000);
  const content = new Map([
    ["dep1.py", big],
    ["dep2.py", "d2"],
    ["dep3.py", "d3"],
    ["target.py", "t"],
  ]);
  const blueprint = [bp("target.py", ["dep1.py", "dep2.py", "dep3.py"])];
  const targets = selectRepairTargets([{ path: "target.py", errors: ["e"] }], content, blueprint, { maxContracts: 2, maxContractChars: 100 });
  assert.equal(targets[0].contracts.length, 2); // teto de contratos
  assert.ok(targets[0].contracts[0].content.length < big.length); // truncado
  assert.match(targets[0].contracts[0].content, /truncado/);
});
