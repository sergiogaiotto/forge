import assert from "node:assert/strict";
import { test } from "node:test";
import { findLayerViolations, parseImports, parseImportsGo, parseImportsJava, parseImportsTs, parsePackageJava } from "../util/layerCheck";

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

test("parseImportsTs: import ES MULTI-LINHA (from em linha separada) é capturado (achado do survey)", () => {
  const c = [
    "import {",
    "  Session,",
    "  Pool,",
    "} from './adapters/db';",
    "export {",
    "  Thing,",
    "} from '../ports/repo';",
    "import { ok } from './single';", // single-line ainda funciona
    "const fromCache = 1;", // 'from' num identificador NÃO casa
  ].join("\n");
  assert.deepEqual(parseImportsTs(c), ["adapters.db", "ports.repo", "single"]);
});

test("REGRESSÃO (survey): violação hexagonal com import MULTI-LINHA NÃO passa mais em silêncio", () => {
  const files = [
    { path: "src/domain/order.ts", content: "import {\n  Session,\n  Pool,\n} from '../adapters/db';\nexport class Order {}" },
    { path: "src/adapters/db.ts", content: "export class Session {}\nexport class Pool {}" },
  ];
  const v = findLayerViolations(files, "hexagonal", "typescript");
  assert.equal(v.length, 1, "o domínio importando adapters via import multi-linha É pego");
  assert.equal(v[0].path, "src/domain/order.ts");
  assert.deepEqual(v[0].imports, ["adapters.db"]);
});

test("parseImportsTs: import multi-linha em COMENTÁRIO/template NÃO é falsa violação (fix da revisão)", () => {
  // O match content-wide poderia pegar um exemplo de uso multi-linha num JSDoc (LLM adora) → FP de camada.
  const jsdoc = "/**\n * Exemplo:\n * import {\n *   Db,\n * } from '../adapters/db';\n */\nexport class Order {}\n";
  assert.deepEqual(parseImportsTs(jsdoc), [], "import multi-linha comentado é ignorado");
  const tmpl = "const example = `\nimport {\n  Db,\n} from '../adapters/db';\n`;\nexport class Order {}\n";
  assert.deepEqual(parseImportsTs(tmpl), [], "import multi-linha em template literal é ignorado");
  // mas um import REAL na MESMA string normal single-line não confunde (o especificador é preservado):
  assert.deepEqual(parseImportsTs("import { Db } from '../adapters/db';"), ["adapters.db"], "import real segue capturado");
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

test("hexagonal TS: arquivo .mjs/.cjs (ESM/CJS) ENTRA no gate de arquitetura (antes o codeRe pulava)", () => {
  // Achado do survey: o codeRe /\.[tj]sx?$/i não cobria .mjs/.cjs → num projeto todo-ESM o gate INTEIRO
  // era pulado (hasCode=false no ProjectGateRunner). Aqui: domínio .mjs importando adapters É violação.
  const files = [
    { path: "src/domain/order.mjs", content: "import { Session } from '../adapters/db.mjs';\nexport class Order {}" },
    { path: "src/adapters/db.mjs", content: "export class Session {}" },
  ];
  const v = findLayerViolations(files, "hexagonal", "typescript");
  assert.equal(v.length, 1, ".mjs é verificado pela arquitetura");
  assert.equal(v[0].path, "src/domain/order.mjs");
  assert.deepEqual(v[0].imports, ["adapters.db"]);
});

test("hexagonal TS: import EXTENSIONLESS resolve p/ arquivo .mjs (CODE_EXT cobre ESM); .cjs também é verificado", () => {
  // require('../adapters/db') SEM extensão deve resolver p/ db.mjs — o CODE_EXT agora strippa .mjs/.cjs, senão
  // a chave do arquivo ficaria 'adapters.db.mjs' e o import 'adapters.db' não casaria (falso-negativo).
  const files = [
    { path: "src/domain/order.cjs", content: "const { Session } = require('../adapters/db');\nmodule.exports = {};" },
    { path: "src/adapters/db.mjs", content: "export class Session {}" },
  ];
  const v = findLayerViolations(files, "hexagonal", "typescript");
  assert.equal(v.length, 1, "o require extensionless resolve p/ db.mjs → violação detectada");
  assert.equal(v[0].path, "src/domain/order.cjs");
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

// ---- Java (por pacote declarado) ----------------------------------------------------------------------

test("parsePackageJava / parseImportsJava: pacote, import de classe, wildcard e static", () => {
  assert.equal(parsePackageJava("package com.acme.shop.domain;\npublic class Order {}"), "com.acme.shop.domain");
  assert.equal(parsePackageJava("public class NoPkg {}"), ""); // pacote default
  const src = [
    "package com.acme.shop.domain;",
    "import com.acme.shop.adapters.Db;", // classe → pacote com.acme.shop.adapters
    "import com.acme.shop.util.*;", // wildcard → com.acme.shop.util
    "import static com.acme.shop.Helpers.log;", // static → com.acme.shop.Helpers (não casa pacote → ignorado)
    "import java.util.List;", // stdlib → java.util
  ].join("\n");
  assert.deepEqual(parseImportsJava(src), ["com.acme.shop.adapters", "com.acme.shop.util", "com.acme.shop.Helpers", "java.util"]);
});

// base = prefixo de pacote COMUM (org base, com.acme.shop) — removido antes de achar a camada.
const javaPkg = (pkg: string, imports: string[] = [], cls = "C") =>
  `package ${pkg};\n${imports.map((i) => `import ${i};`).join("\n")}\npublic class ${cls} {}`;

test("hexagonal Java: domínio importando adapters é VIOLAÇÃO (por pacote declarado)", () => {
  const files = [
    { path: "src/main/java/com/acme/shop/domain/Order.java", content: javaPkg("com.acme.shop.domain", ["com.acme.shop.adapters.Db"], "Order") },
    { path: "src/main/java/com/acme/shop/adapters/Db.java", content: javaPkg("com.acme.shop.adapters", [], "Db") },
  ];
  const v = findLayerViolations(files, "hexagonal", "java");
  assert.equal(v.length, 1);
  assert.equal(v[0].path, "src/main/java/com/acme/shop/domain/Order.java");
  assert.deepEqual(v[0].imports, ["com.acme.shop.adapters"]);
});

test("Java: adapter→domínio PERMITIDO; stdlib e terceiros nunca são violação", () => {
  const files = [
    { path: "d/Order.java", content: javaPkg("com.acme.shop.domain", ["java.util.List", "org.springframework.stereotype.Component"], "Order") },
    { path: "a/Db.java", content: javaPkg("com.acme.shop.adapters", ["com.acme.shop.domain.Order"], "Db") },
  ];
  assert.deepEqual(findLayerViolations(files, "hexagonal", "java"), []);
});

// REGRESSÃO (Regra de Ouro, mesma lição do Go): um import de TERCEIROS cujo pacote termina com um nome de
// camada (org.example.adapters.X) NÃO pode falso-bloquear — só pacotes DECLARADOS pelos arquivos gerados casam.
test("Java: terceiro com nome de camada (org.example.adapters) NÃO é violação", () => {
  const files = [
    { path: "d/Order.java", content: javaPkg("com.acme.shop.domain", ["org.example.adapters.HttpClient"], "Order") },
    { path: "a/Db.java", content: javaPkg("com.acme.shop.adapters", [], "Db") },
  ];
  assert.deepEqual(findLayerViolations(files, "hexagonal", "java"), []); // org.example.adapters ≠ pacote gerado
});

// REGRESSÃO: um org base que CONTÉM um alias de camada ("service" em com.service.shop) é REMOVIDO antes de
// achar a camada (o prefixo comum). Sem isso, o "service" (alias externo) rotularia TODO arquivo como externo
// e a violação real seria PERDIDA (falso-negativo). Com o strip, model→repository é corretamente detectada.
test("Java: org base com alias de camada (com.service.shop) — violação ainda é detectada", () => {
  const files = [
    { path: "m/User.java", content: javaPkg("com.service.shop.model", ["com.service.shop.repository.Repo"], "User") },
    { path: "r/Repo.java", content: javaPkg("com.service.shop.repository", [], "Repo") },
  ];
  const v = findLayerViolations(files, "layered", "java");
  assert.equal(v.length, 1);
  assert.equal(v[0].path, "m/User.java");
  assert.deepEqual(v[0].imports, ["com.service.shop.repository"]);
});

// domain.repositories (uma PORT do domínio) é INNER pelo primeiro-alias, não outer — importá-la do domínio é ok.
test("Java: domain.repositories (port) é INNER, não falso-bloqueia", () => {
  const files = [
    { path: "d/Order.java", content: javaPkg("com.acme.shop.domain", ["com.acme.shop.domain.repositories.OrderRepo"], "Order") },
    { path: "r/OrderRepo.java", content: javaPkg("com.acme.shop.domain.repositories", [], "OrderRepo") },
  ];
  assert.deepEqual(findLayerViolations(files, "hexagonal", "java"), []);
});

test("mvc Java: Model importando Controller é VIOLAÇÃO; View→Model permitido", () => {
  const bad = findLayerViolations(
    [
      { path: "m/User.java", content: javaPkg("com.acme.app.model", ["com.acme.app.controller.Auth"], "User") },
      { path: "c/Auth.java", content: javaPkg("com.acme.app.controller", [], "Auth") },
    ],
    "mvc",
    "java"
  );
  assert.equal(bad.length, 1);
  assert.equal(bad[0].path, "m/User.java");
  assert.deepEqual(bad[0].imports, ["com.acme.app.controller"]);
  const ok = findLayerViolations(
    [
      { path: "m/User.java", content: javaPkg("com.acme.app.model", [], "User") },
      { path: "v/Page.java", content: javaPkg("com.acme.app.view", ["com.acme.app.model.User"], "Page") },
    ],
    "mvc",
    "java"
  );
  assert.deepEqual(ok, []);
});

// REGRESSÃO CRÍTICA (revisão adversarial, HIGH — Regra de Ouro): projeto MULTI-CONTEXTO cujo prefixo comum
// colapsa para [com] e um NOME DE ORG é palavra-de-camada (com.infra.* = empresa "Infra"). O first-alias
// rotularia domain como outer → falso-bloqueio. Fix: base < 2 segmentos → fail-open (nada bloqueado).
test("Java: multi-contexto com org=palavra-de-camada (com.infra vs com.reports) NÃO falso-bloqueia", () => {
  const files = [
    { path: "r/Report.java", content: "package com.reports.domain;\nimport com.infra.billing.domain.Invoice;\npublic class Report {}" },
    { path: "b/Invoice.java", content: "package com.infra.billing.domain;\npublic class Invoice {}" },
  ];
  assert.deepEqual(findLayerViolations(files, "hexagonal", "java"), []); // base=[com] → fail-open
  // idem clean/mvc com org colidente
  assert.deepEqual(
    findLayerViolations(
      [
        { path: "c/Core.java", content: "package com.reports.entities;\nimport com.gateways.core.entities.Money;\npublic class Core {}" },
        { path: "g/Money.java", content: "package com.gateways.core.entities;\npublic class Money {}" },
      ],
      "clean",
      "java"
    ),
    []
  );
});

// Regra de CONFLITO (base>=2): um NOME DE CONTEXTO que é alias (com.acme.infra.* = contexto "infra") não pode
// shadowar a camada real. domain de um contexto importando domain de outro contexto é legítimo.
test("Java: contexto com nome de alias (com.acme.infra) NÃO falso-bloqueia (regra de conflito)", () => {
  const files = [
    { path: "b/Order.java", content: "package com.acme.billing.domain;\nimport com.acme.infra.billing.domain.Money;\npublic class Order {}" },
    { path: "i/Money.java", content: "package com.acme.infra.billing.domain;\npublic class Money {}" }, // base=[com,acme]; [infra,billing,domain] → infra+domain conflito → other
  ];
  assert.deepEqual(findLayerViolations(files, "hexagonal", "java"), []);
});

// REGRESSÃO (revisão adversarial, LOW — Regra de Ouro): um `package X;` COMENTADO (dentro de /* */) antes do
// package real reclassificaria o arquivo → falso-bloqueio. parsePackageJava agora ignora comentários.
test("Java: package comentado (/* */ ou //) NÃO reclassifica nem falso-bloqueia", () => {
  assert.equal(parsePackageJava("/*\npackage com.fake.domain;\n*/\npackage com.real.adapters;\nclass X{}"), "com.real.adapters");
  assert.equal(parsePackageJava("// package com.fake.domain;\npackage com.real.adapters;\nclass X{}"), "com.real.adapters");
  const files = [
    { path: "a/Db.java", content: "/*\npackage com.acme.shop.domain;\n*/\npackage com.acme.shop.adapters;\nimport com.acme.shop.adapters.support.Helper;\nclass Db{}" },
    { path: "s/Helper.java", content: "package com.acme.shop.adapters.support;\nclass Helper{}" },
    { path: "d/Order.java", content: "package com.acme.shop.domain;\nclass Order{}" },
  ];
  // Db é adapter (não domain): importar adapters.support é legítimo → sem violação
  assert.deepEqual(findLayerViolations(files, "hexagonal", "java"), []);
});
