import assert from "node:assert/strict";
import { test } from "node:test";
import { findLayerViolations, parseImports, parseImportsTs } from "../util/layerCheck";

test("parseImports: cobre import/from/relativo/as/vírgula, devolve o MÓDULO", () => {
  const c = [
    "import os",
    "import a.b as c",
    "import x, y.z",
    "from adapters.db import Session",
    "from ..adapters.http import Client",
    "from . import util", // módulo = "." (pacote atual) → nada a rastrear (import intra-pacote)
  ].join("\n");
  assert.deepEqual(parseImports(c), ["os", "a.b", "x", "y.z", "adapters.db", "adapters.http"]);
});

// REGRA DE OURO (hexagonal): domínio importando adapters é violação — o import resolve para adapters/db.py.
test("hexagonal: domínio importando adapters é VIOLAÇÃO", () => {
  const files = [
    { path: "src/domain/order.py", content: "from adapters.db import Session\nclass Order: ..." },
    { path: "src/adapters/db.py", content: "class Session: ..." },
    { path: "src/ports/repo.py", content: "class Repo: ..." },
  ];
  const v = findLayerViolations(files, "hexagonal");
  assert.equal(v.length, 1);
  assert.equal(v[0].path, "src/domain/order.py");
  assert.deepEqual(v[0].imports, ["adapters.db"]);
});

// application/use_cases NÃO é a camada interna (só domínio/entidades). O caso de uso orquestra via
// ports/adapters, então importar adapters ali é PERMITIDO — a regra enforçada é só domínio↛externo.
test("hexagonal: use_cases importando adapters NÃO é violação (não é a camada interna)", () => {
  const files = [
    { path: "src/use_cases/create_order.py", content: "from adapters.db import Session" },
    { path: "src/adapters/db.py", content: "class Session: ..." },
  ];
  assert.deepEqual(findLayerViolations(files, "hexagonal"), []);
});

// O adapter importando o domínio é PERMITIDO (a dependência aponta para dentro) — não é violação.
test("hexagonal: adapter importando domínio é PERMITIDO (não vira violação)", () => {
  const files = [
    { path: "src/domain/order.py", content: "class Order: ..." },
    { path: "src/adapters/db.py", content: "from domain.order import Order\nclass Session: ..." },
  ];
  assert.deepEqual(findLayerViolations(files, "hexagonal"), []);
});

// FALSO-POSITIVO evitado: um arquivo domain/repositories.py (porta) é INNER apesar do nome; importá-lo de
// dentro do domínio NÃO é violação.
test("hexagonal: domínio importando uma PORTA (domain/repositories.py) NÃO é violação", () => {
  const files = [
    { path: "domain/service.py", content: "from domain.repositories import OrderRepo" },
    { path: "domain/repositories.py", content: "class OrderRepo: ..." },
  ];
  assert.deepEqual(findLayerViolations(files, "hexagonal"), []);
});

// FALSO-POSITIVO evitado: import externo/stdlib nunca é violação (não resolve para arquivo gerado).
test("import externo/stdlib nunca é violação (pydantic, http, requests)", () => {
  const files = [
    { path: "src/domain/order.py", content: "import http.client\nfrom pydantic import BaseModel\nimport requests" },
    { path: "src/adapters/db.py", content: "class Session: ..." },
  ];
  assert.deepEqual(findLayerViolations(files, "hexagonal"), []);
});

// AMBIGUIDADE → não bloqueia: um sufixo "repositories" que resolve para INNER e OUTER ao mesmo tempo é
// pulado (conservador — nunca bloqueia por engano).
test("import ambíguo (resolve para inner E outer) é pulado, não vira violação", () => {
  const files = [
    { path: "domain/svc.py", content: "from repositories import Thing" },
    { path: "domain/repositories.py", content: "class Thing: ..." }, // inner
    { path: "adapters/repositories.py", content: "class Thing: ..." }, // outer
  ];
  assert.deepEqual(findLayerViolations(files, "hexagonal"), []); // "repositories" → {inner, outer} → pula
});

// MVC: Model importando Controller/View é violação.
test("mvc: Model importando Controller é VIOLAÇÃO; View importando Model é permitido", () => {
  const bad = findLayerViolations(
    [
      { path: "app/model/user.py", content: "from controller.auth import login" },
      { path: "app/controller/auth.py", content: "def login(): ..." },
    ],
    "mvc"
  );
  assert.equal(bad.length, 1);
  assert.equal(bad[0].path, "app/model/user.py");
  const ok = findLayerViolations(
    [
      { path: "app/model/user.py", content: "class User: ..." },
      { path: "app/view/page.py", content: "from model.user import User" },
    ],
    "mvc"
  );
  assert.deepEqual(ok, []);
});

// Layered: model importando repository/service é violação.
test("layered: model importando repository é VIOLAÇÃO", () => {
  const v = findLayerViolations(
    [
      { path: "model/customer.py", content: "from repository.customer_repo import load" },
      { path: "repository/customer_repo.py", content: "def load(): ..." },
    ],
    "layered"
  );
  assert.equal(v.length, 1);
  assert.deepEqual(v[0].imports, ["repository.customer_repo"]);
});

// Clean: entities importando frameworks é violação (relativo com '..').
test("clean: entities importando frameworks (import relativo) é VIOLAÇÃO", () => {
  const v = findLayerViolations(
    [
      { path: "src/entities/user.py", content: "from ..frameworks.orm import Base" },
      { path: "src/frameworks/orm.py", content: "class Base: ..." },
    ],
    "clean"
  );
  assert.equal(v.length, 1);
  assert.equal(v[0].path, "src/entities/user.py");
});

// Projeto coerente (sem imports proibidos) → zero violações.
test("projeto hexagonal coerente → nenhuma violação", () => {
  const files = [
    { path: "src/ports/repo.py", content: "class Repo: ..." },
    { path: "src/domain/order.py", content: "from ports.repo import Repo\nclass Order: ..." },
    { path: "src/adapters/db.py", content: "from ports.repo import Repo\nfrom domain.order import Order" },
    { path: "src/app/main.py", content: "from adapters.db import X" },
  ];
  assert.deepEqual(findLayerViolations(files, "hexagonal"), []);
});

// ---- P4: arquitetura para TypeScript ------------------------------------------

test("parseImportsTs: cobre import/from, export-from, side-effect, require, import() e SÓ relativos", () => {
  const c = [
    "import React from 'react'", // bare → ignorado
    "import { Session } from './adapters/db'",
    "import type { Repo } from '../ports/repo'",
    "export { X } from './x'",
    "import './styles.css'", // side-effect relativo
    "const cfg = require('../config')",
    "const m = await import('./lazy')",
    "import ns from '@scope/pkg'", // @scope → ignorado
  ].join("\n");
  assert.deepEqual(parseImportsTs(c), ["adapters.db", "ports.repo", "x", "styles.css", "config", "lazy"]);
});

test("hexagonal TS: domínio importando adapters é VIOLAÇÃO (import relativo)", () => {
  const files = [
    { path: "src/domain/order.ts", content: "import { Session } from '../adapters/db';\nexport class Order {}" },
    { path: "src/adapters/db.ts", content: "export class Session {}" },
  ];
  const v = findLayerViolations(files, "hexagonal", "typescript");
  assert.equal(v.length, 1);
  assert.equal(v[0].path, "src/domain/order.ts");
  assert.deepEqual(v[0].imports, ["adapters.db"]);
});

test("hexagonal TS: adapter importando domínio é PERMITIDO; use_cases idem", () => {
  const files = [
    { path: "src/domain/order.ts", content: "export class Order {}" },
    { path: "src/adapters/db.ts", content: "import { Order } from '../domain/order';\nexport class Session {}" },
    { path: "src/use_cases/create.ts", content: "import { Session } from '../adapters/db';" },
  ];
  assert.deepEqual(findLayerViolations(files, "hexagonal", "typescript"), []);
});

test("TS: import BARE (dep de terceiros) nunca é violação", () => {
  const files = [
    { path: "src/domain/order.tsx", content: "import express from 'express';\nimport { z } from 'zod';\nexport const x = 1;" },
    { path: "src/adapters/db.ts", content: "export class Session {}" },
  ];
  assert.deepEqual(findLayerViolations(files, "hexagonal", "typescript"), []);
});

test("mvc TS: Model importando Controller é VIOLAÇÃO; View importando Model permitido", () => {
  const bad = findLayerViolations(
    [
      { path: "app/model/user.ts", content: "import { login } from '../controller/auth';" },
      { path: "app/controller/auth.ts", content: "export function login() {}" },
    ],
    "mvc",
    "typescript"
  );
  assert.equal(bad.length, 1);
  assert.equal(bad[0].path, "app/model/user.ts");
});

// REGRESSÃO (revisão): um MÓDULO DE RAIZ cujo NOME de arquivo coincide com um alias de camada (src/adapter.ts,
// src/service.ts) NÃO é a camada externa — só DIRETÓRIOS decidem a camada. Importá-lo do domínio é legítimo.
test("TS: módulo de raiz com basename de alias (adapter.ts/service.ts) NÃO falso-bloqueia", () => {
  const hex = findLayerViolations(
    [
      { path: "src/domain/order.ts", content: "import { AdapterToken } from '../adapter';\nimport { A } from '../infra.js';" },
      { path: "src/adapter.ts", content: "export const AdapterToken = Symbol('x');" },
      { path: "src/infra.ts", content: "export const A = 1;" },
      { path: "src/adapters/db.ts", content: "export class Db {}" }, // a camada externa REAL (diretório)
    ],
    "hexagonal",
    "typescript"
  );
  assert.deepEqual(hex, []); // ../adapter e ../infra.js são módulos de raiz, não a camada de adapters/infra
  // import type do módulo de raiz 'service' num projeto layered — também não é violação
  const layered = findLayerViolations(
    [
      { path: "model/customer.ts", content: "import type { S } from '../service';" },
      { path: "service.ts", content: "export type S = number;" },
    ],
    "layered",
    "typescript"
  );
  assert.deepEqual(layered, []);
  // mas a camada externa REAL (diretório service/) ainda é violação
  const realViolation = findLayerViolations(
    [
      { path: "model/customer.ts", content: "import { load } from '../service/customer_svc';" },
      { path: "service/customer_svc.ts", content: "export function load() {}" },
    ],
    "layered",
    "typescript"
  );
  assert.equal(realViolation.length, 1);
});
