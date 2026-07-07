import assert from "node:assert/strict";
import { test } from "node:test";
import { findLayerViolations, parseImports, parseImportsGo, parseImportsTs } from "../util/layerCheck";

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

// ---- Go -----------------------------------------------------------------------------------------------

test("parseImportsGo: import único, com alias, e bloco com _/./alias e comentários", () => {
  const single = 'package domain\nimport "fmt"\nimport m "example.com/mod/adapters/db"';
  assert.deepEqual(parseImportsGo(single), ["fmt", "example.com/mod/adapters/db"]);
  const block = [
    "package x",
    "import (",
    '\t"fmt" // stdlib',
    '\t"os"',
    '\t_ "github.com/lib/pq"', // import em branco (efeito colateral)
    '\t. "example.com/mod/util"', // dot-import
    '\talias "example.com/mod/domain/order"',
    ")",
    'func main() { _ = "import not-a-real-import" }', // ruído fora de bloco → ignorado
  ].join("\n");
  assert.deepEqual(parseImportsGo(block), ["fmt", "os", "github.com/lib/pq", "example.com/mod/util", "example.com/mod/domain/order"]);
});

test("parseImportsGo: bloco de uma linha `import ( \"x\" )`", () => {
  assert.deepEqual(parseImportsGo('import ( "fmt" )'), ["fmt"]);
  assert.deepEqual(parseImportsGo("import ()"), []); // bloco vazio
});

// REGRESSÃO CRÍTICA (2ª passada adversarial): o texto de um COMENTÁRIO com `;` e um caminho entre aspas NÃO
// pode virar import fabricado (era um falso-bloqueio da Regra de Ouro). O regex é ancorado no início da linha,
// então só o 1º literal conta. Custo aceito: a forma exótica `import ( "a"; "b" )` capta só o 1º (fail-open).
test("parseImportsGo: comentário com `;`+aspas NÃO fabrica import; `;`-multi capta só o 1º (fail-open)", () => {
  assert.deepEqual(parseImportsGo('import (\n\t"fmt" // legacy; was "example.com/shop/adapters/db"\n)'), ["fmt"]);
  assert.deepEqual(parseImportsGo('import (\n\t"fmt" /* x; "example.com/shop/adapters/db" */\n)'), ["fmt"]);
  assert.deepEqual(parseImportsGo('import (\n\t"fmt"; "os"\n)'), ["fmt"]); // `;`-multi: só o 1º (miss conservador)
});

// go.mod dá o PREFIXO do módulo — é o que distingue import interno de dep de terceiros (análogo Go do
// bare/@scope do TS). Sem ele o gate Go de arquitetura degrada para conservador (sem violações).
const goMod = (module = "example.com/shop") => ({ path: "go.mod", content: `module ${module}\n\ngo 1.21` });

test("hexagonal Go: domínio importando adapters é VIOLAÇÃO (caminho ancorado no prefixo do módulo)", () => {
  const files = [
    goMod(),
    { path: "internal/domain/order.go", content: 'package domain\nimport "example.com/shop/internal/adapters/db"\ntype Order struct{}' },
    { path: "internal/adapters/db/store.go", content: "package db\ntype Store struct{}" },
  ];
  const v = findLayerViolations(files, "hexagonal", "go");
  assert.equal(v.length, 1);
  assert.equal(v[0].path, "internal/domain/order.go");
  assert.deepEqual(v[0].imports, ["example.com/shop/internal/adapters/db"]);
});

test("Go: adapter importando domínio é PERMITIDO; stdlib e terceiros nunca são violação", () => {
  const files = [
    goMod(),
    { path: "domain/order.go", content: 'package domain\nimport (\n\t"fmt"\n\t"github.com/google/uuid"\n)\ntype Order struct{}' },
    { path: "adapters/db/store.go", content: 'package db\nimport "example.com/shop/domain"\ntype Store struct{}' },
  ];
  assert.deepEqual(findLayerViolations(files, "hexagonal", "go"), []);
});

// REGRESSÃO CRÍTICA (revisão adversarial, provado ao vivo): um import de TERCEIROS cujo segmento final coincide
// com o nome de um pacote OUTER gerado NÃO pode falso-bloquear (viola a Regra de Ouro). O prefixo do módulo é
// o que fecha isso — `github.com/acme/infra` não começa com `example.com/shop/` → dep externa → ignorado.
test("Go: import de TERCEIROS que colide com nome de pacote OUTER gerado NÃO é violação", () => {
  const infra = { path: "infra/config.go", content: "package infra" }; // pacote OUTER gerado chamado 'infra'
  // segmento final único
  assert.deepEqual(
    findLayerViolations([goMod(), { path: "domain/order.go", content: 'package domain\nimport "github.com/acme/infra"' }, infra], "hexagonal", "go"),
    []
  );
  // multi-segmento (…/adapters/db vs adapters/db/ gerado)
  assert.deepEqual(
    findLayerViolations(
      [goMod(), { path: "domain/order.go", content: 'package domain\nimport "github.com/company/platform/adapters/db"' }, { path: "adapters/db/store.go", content: "package db" }],
      "hexagonal",
      "go"
    ),
    []
  );
  // irmão de monorepo: mesmo host/org, prefixo de MÓDULO diferente → externo
  assert.deepEqual(
    findLayerViolations(
      [goMod("github.com/myco/shop"), { path: "domain/order.go", content: 'package domain\nimport "github.com/myco/platform/infrastructure"' }, { path: "infrastructure/x.go", content: "package infrastructure" }],
      "hexagonal",
      "go"
    ),
    []
  );
});

// FAIL-OPEN: sem go.mod (prefixo do módulo desconhecido) não dá para distinguir interno de terceiros → não
// bloqueia NADA, mesmo o cenário que SERIA violação com o go.mod presente.
test("Go: sem go.mod → nenhuma violação (fail-open)", () => {
  const files = [
    { path: "internal/domain/order.go", content: 'package domain\nimport "example.com/shop/internal/adapters/db"' },
    { path: "internal/adapters/db/store.go", content: "package db" },
  ];
  assert.deepEqual(findLayerViolations(files, "hexagonal", "go"), []);
});

// REGRESSÃO (Regra de Ouro, 2ª passada): um arquivo de domínio cujo COMENTÁRIO menciona um import de adapters
// (com `;`) importa só stdlib de fato — NÃO pode ser bloqueado (o `go list` confirmaria imports=[fmt]).
test("Go: comentário mencionando import de adapters NÃO falso-bloqueia", () => {
  const files = [
    goMod(),
    { path: "domain/order.go", content: 'package domain\nimport (\n\t"fmt" // legacy; was "example.com/shop/adapters/db"\n)\ntype Order struct{}' },
    { path: "adapters/db/store.go", content: "package db" },
  ];
  assert.deepEqual(findLayerViolations(files, "hexagonal", "go"), []);
});

// module = "app"; um pacote no diretório controller/ (relativo à raiz do módulo) é importado como "app/controller".
test("mvc Go: Model importando Controller é VIOLAÇÃO; View→Model permitido", () => {
  const bad = findLayerViolations(
    [
      goMod("app"),
      { path: "model/user.go", content: 'package model\nimport "app/controller"\ntype U struct{}' },
      { path: "controller/auth.go", content: "package controller" },
    ],
    "mvc",
    "go"
  );
  assert.equal(bad.length, 1);
  assert.equal(bad[0].path, "model/user.go");
  assert.deepEqual(bad[0].imports, ["app/controller"]);
  const ok = findLayerViolations(
    [
      goMod("app"),
      { path: "model/user.go", content: "package model\ntype U struct{}" },
      { path: "view/page.go", content: 'package view\nimport "app/model"' },
    ],
    "mvc",
    "go"
  );
  assert.deepEqual(ok, []);
});
