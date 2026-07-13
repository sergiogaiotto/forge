---
name: python-hexagonal-backend
description: >-
  Playbook for generating a Python backend or API with hexagonal architecture
  (ports and adapters). Use whenever the user asks for a Python backend, a REST
  API, a FastAPI or Flask service, a microservice, a web service, a worker, or a
  use-case / domain layer, or mentions hexagonal, ports and adapters, clean
  architecture, or dependency inversion. Covers the layer layout the architecture
  gate enforces (a pure domain that never imports adapters or frameworks), ports
  as Protocol/ABC interfaces, adapters that implement them, dependency injection
  at a composition root, keeping FastAPI and the ORM at the edge, and shipping a
  runnable, tested, documented service.
license: Apache-2.0
metadata:
  author: claro-data-platform
  version: "1.0"
---

# Python backend — hexagonal architecture (ports & adapters)

A generated Python backend usually works in a happy-path demo yet rots fast: the
business rules are tangled with FastAPI request objects and SQLAlchemy models, the
core imports the database driver, and there is no seam to test or swap anything. This
skill encodes a senior backend playbook — **ports and adapters** — so the generated
service is layered, testable, and runnable by default, and so it passes the FORGE
architecture gate (which blocks a domain module that imports an adapter).

## When to use

Use this skill when generating a Python **backend / API / service**: a FastAPI or
Flask REST API, a microservice, a worker, a CLI with real business logic, or anything
built around **use cases and a domain**. It does **not** apply to data pipelines
(pandas, polars, Spark, dbt, Airflow — those have their own skills) or to a one-file
throwaway script. If the request is a small script with no domain, don't over-architect
it.

## The dependency rule (what the gate enforces)

**Dependencies point INWARD.** The domain is the pure center; everything else depends
on it, never the reverse. The FORGE architecture gate materializes exactly this rule:
a file under `domain/` (or `entities/`) that imports a module under `adapters/`,
`infrastructure/`, `repositories/`, or `controllers/` **blocks the Apply**. Generate
the structure so that never happens.

```
src/
  domain/            # INNER — pure. Entities, value objects, and PORTS (interfaces).
    models.py        #   dataclasses with invariants (no framework imports)
    ports.py         #   Protocol / ABC interfaces the domain DEPENDS ON
    errors.py        #   domain exceptions
  application/       # use cases: orchestrate domain through ports. Depends on domain only.
    create_order.py
  adapters/          # OUTER — implement the ports + inbound web. Depends INWARD.
    repository.py    #   e.g. SqlOrderRepository(OrderRepository)
    api.py           #   FastAPI router: HTTP → use case (framework lives HERE)
  main.py            # composition root: build concrete adapters, inject into use cases
requirements.txt     # every third-party package actually imported
tests/
  test_create_order.py   # a use case tested with a FAKE adapter (no DB needed)
README.md            # a "## How to run" section (install + run)
```

## Rules (apply all that fit)

### 1. The domain is pure — no framework imports
Entities and value objects are plain `@dataclass`es that own their invariants. The
domain never imports FastAPI, Flask, SQLAlchemy, pydantic (for I/O), `requests`, a DB
driver, or anything under `adapters/`. If the core imports a framework, it is no longer
the core.

```python
# domain/models.py  ✅ pure: stdlib only, invariant enforced on construction
from dataclasses import dataclass, field

@dataclass(frozen=True)
class Order:
    id: str
    customer_id: str
    total_cents: int
    def __post_init__(self) -> None:
        if self.total_cents < 0:
            raise ValueError("total_cents must be >= 0")
```

```python
# ❌ domain importing an adapter / framework — the gate BLOCKS this file
from adapters.repository import SqlOrderRepository   # domain must not know adapters
from fastapi import HTTPException                     # web framework in the core
```

### 2. Declare ports IN the domain as interfaces
The domain says *what it needs* (a repository that can `get`/`save`); an adapter later
says *how*. Use `typing.Protocol` (structural, no inheritance needed) or `abc.ABC`. The
port lives in the domain because the domain owns the contract.

```python
# domain/ports.py  ✅ the interface the domain depends on
from typing import Protocol
from domain.models import Order

class OrderRepository(Protocol):
    def get(self, order_id: str) -> Order | None: ...
    def save(self, order: Order) -> None: ...
```

### 3. Adapters implement ports and depend on the domain (never the reverse)
A concrete repository lives under `adapters/`, imports the domain, and satisfies the
port. The arrow points inward: `adapters` → `domain`, so no gate violation.

```python
# adapters/repository.py  ✅ imports domain, implements the port
from domain.models import Order
from domain.ports import OrderRepository

class InMemoryOrderRepository:            # satisfies OrderRepository structurally
    def __init__(self) -> None:
        self._store: dict[str, Order] = {}
    def get(self, order_id: str) -> Order | None:
        return self._store.get(order_id)
    def save(self, order: Order) -> None:
        self._store[order.id] = order
```

### 4. Use cases orchestrate the domain through ports
A use case (application layer) receives ports by constructor injection and coordinates
the domain. It depends on `domain` only — never on a concrete adapter.

```python
# application/create_order.py
from domain.models import Order
from domain.ports import OrderRepository

class CreateOrder:
    def __init__(self, orders: OrderRepository) -> None:
        self._orders = orders           # a PORT, not a concrete class
    def execute(self, order_id: str, customer_id: str, total_cents: int) -> Order:
        order = Order(id=order_id, customer_id=customer_id, total_cents=total_cents)
        self._orders.save(order)
        return order
```

### 5. Keep the web framework at the edge; don't leak I/O models into the domain
FastAPI routers and pydantic request/response schemas are an **inbound adapter** — they
live under `adapters/`, not in the domain. Convert the request model to domain arguments
at the boundary and return a plain response model; never pass a pydantic or ORM object
into the domain.

```python
# adapters/api.py  ✅ HTTP boundary calls the use case
from fastapi import APIRouter
from pydantic import BaseModel
from application.create_order import CreateOrder

class CreateOrderIn(BaseModel):
    order_id: str
    customer_id: str
    total_cents: int

def make_router(create_order: CreateOrder) -> APIRouter:
    router = APIRouter()
    @router.post("/orders")
    def post_order(body: CreateOrderIn) -> dict:
        order = create_order.execute(body.order_id, body.customer_id, body.total_cents)
        return {"id": order.id, "total_cents": order.total_cents}
    return router
```

### 6. Wire everything at ONE composition root
`main.py` is the only place that knows concrete adapters. It builds them and injects
them into the use cases — the single spot where the dependency graph is assembled.

```python
# main.py  ✅ the composition root — the ONLY module wiring concretes
from fastapi import FastAPI
from adapters.repository import InMemoryOrderRepository
from adapters.api import make_router
from application.create_order import CreateOrder

def build_app() -> FastAPI:
    repo = InMemoryOrderRepository()          # swap for SqlOrderRepository in prod
    create_order = CreateOrder(orders=repo)   # inject the port implementation
    app = FastAPI()
    app.include_router(make_router(create_order))
    return app

app = build_app()
```

### 7. Ship it runnable, tested, and documented
The ports make the domain testable without a database: test a use case with a **fake
adapter**. Also emit a dependency manifest and a README with how to run — the DoD gate
blocks a project missing any of these.

```python
# tests/test_create_order.py  ✅ no DB, no FastAPI — the fake satisfies the port
from application.create_order import CreateOrder
from adapters.repository import InMemoryOrderRepository

def test_create_order_persists_and_returns() -> None:
    repo = InMemoryOrderRepository()
    order = CreateOrder(orders=repo).execute("o1", "c1", 500)
    assert order.total_cents == 500
    assert repo.get("o1") == order
```

- `requirements.txt` — list every third-party package the code imports (e.g. `fastapi`,
  `uvicorn`), so the project installs. The FORGE gate reconciles missing ones, but
  declare them yourself.
- `README.md` — include a **`## How to run`** section with the install + run commands
  (`pip install -r requirements.txt`, `uvicorn main:app --reload`).

## Common errors to avoid
- `domain/` importing FastAPI, SQLAlchemy, `requests`, or anything under `adapters/` —
  the architecture gate blocks that file (dependencies must point inward).
- **Anemic domain**: entities are dumb data bags and all rules live in the service or the
  route. Put invariants and behavior on the entity.
- **Fat controller**: business logic inside the FastAPI route handler. The handler should
  only translate HTTP to a use-case call and back.
- Using the **ORM model as the domain entity** — couples the core to the database. Map
  ORM ↔ domain inside the repository adapter.
- **No port**: a use case importing the concrete DB class directly, so nothing can be
  tested or swapped. Depend on a `Protocol` / `ABC`, not a concrete adapter.
- Missing `requirements.txt`, no test, or a README with no "how to run" — the DoD gate
  blocks the Apply.
</content>
