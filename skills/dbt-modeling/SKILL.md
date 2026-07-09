---
name: dbt-modeling
description: >-
  Build and review dbt models, sources, tests, seeds and macros following layered
  modeling (staging/intermediate/marts) and incremental strategies. Use whenever the user
  works with dbt, .sql models in a dbt project, schema.yml, or dbt tests.
license: Apache-2.0
metadata:
  author: claro-data-platform
  version: "1.0"
templates:
  - src: templates/dbt_project.yml.tmpl
    dest: dbt_project.yml
  - src: templates/gitignore.tmpl
    dest: .gitignore
---

# dbt-modeling

**Read before you write. Build after you write. Verify the output — compiling is not success.**

Senior-level guidance for designing, building and reviewing dbt projects. The goal is a
clean, layered, testable warehouse: raw sources are isolated, transformations are explicit,
and costly operations (full table scans, full refreshes) are deliberate rather than
accidental.

## Critical rules

- **ALWAYS discover conventions first.** Before writing any model, read `dbt_project.yml` and
  2–3 existing models + their `schema.yml` in the target layer. Imitate the project's naming,
  YAML style, test depth and packages in use (do NOT introduce `dbt_utils` if the project does
  not already use it). Misaligned conventions are the #1 review rejection.
- **ALWAYS state the grain.** Every model starts by answering "one row per what?" — put it in
  the model's `description`. If you cannot state the grain, you are not ready to write SQL.
- **NEVER declare success after compile.** The verification ladder is: compile (syntax) →
  `dbt build --select <model>` (runs model AND its tests) → `dbt show --select <model> --limit 5`
  (output exists and looks right) → recalculate ONE row by hand against the source → re-read
  the original request ("did I solve the real problem or just make the error go away?").
- **NEVER invent table or column names.** Use the "Schema real do projeto dbt" block from the
  context when present; if a column you need is not there, say so instead of guessing.
- **Three-failure rule.** If `dbt build` fails 3+ times on the same model, STOP iterating on
  micro-fixes. Re-read the error end-to-end, inspect the real data, check the upstream models
  (many failures originate upstream, not in the model you are editing), and reassess the whole
  approach.
- **Blast radius before refactoring.** Before changing an existing model, enumerate downstream
  dependents (`/impacto <modelo>` in FORGE, or `dbt ls --select <model>+`) and check which
  columns they consume. Report the impact scope; change one thing at a time and validate that
  row counts did not shift.

## When to use

Use this skill whenever the task touches a dbt project, including when the user:

- Adds or refactors `.sql` models inside a dbt project (anything under `models/`).
- Asks to create or review **staging**, **intermediate**, or **marts** models.
- Declares raw tables in `sources` or wires `source()` / `ref()` dependencies.
- Chooses a **materialization** (`view`, `table`, `incremental`, `ephemeral`).
- Writes or debugs an **incremental** model (`unique_key`, `is_incremental()`, `--full-refresh`).
- Adds **schema.yml** tests (`unique`, `not_null`, `accepted_values`, `relationships`) or `seeds`.
- Writes or reviews a **macro**, or asks why a `dbt run` / `dbt build` is slow, duplicating rows, or failing on a dependency cycle.

If the work is plain SQL with no dbt project (no `dbt_project.yml`, no `ref()`/`source()`),
this skill does not apply.

## Steps

1. **Identify the layer.** Decide where the model belongs and name it accordingly:
   - `stg_<source>__<entity>` — staging: 1:1 with a raw table, light cleaning only (rename,
     cast, basic filters). One staging model per source table. No joins, no business logic.
   - `int_<entity>__<verb>` — intermediate: reusable joins/reshaping that feed marts. Not
     exposed to BI. Keep ephemeral or view unless reused heavily.
   - `fct_<process>` / `dim_<entity>` — marts: business-facing facts and dimensions consumed
     by BI and analysts.

2. **Wire dependencies correctly.** Reference raw tables only through `source()` and **only in
   staging models**. Reference other models exclusively through `ref()`. Never hardcode a
   schema-qualified table name in a model body — it breaks lineage and environment swaps.

3. **Choose the materialization** based on cost and freshness needs:
   - `view` — default for staging/intermediate; cheap to build, always fresh, no storage.
   - `table` — marts that are queried often and are expensive to recompute on read.
   - `incremental` — large facts/event tables where rebuilding the whole table each run is too
     costly; only new/changed rows are processed.
   - `ephemeral` — small helper logic inlined as a CTE into downstream models; produces no
     warehouse object. Good for `int_` glue used by exactly one or two consumers.

4. **Design incremental models deliberately.** Set a `unique_key` (so late-arriving/updated rows
   are merged, not duplicated), guard the incremental predicate with `is_incremental()`, and
   filter on a high-watermark column (e.g. `updated_at`) against `{{ this }}`. Pick an explicit
   `incremental_strategy` (`merge`, `delete+insert`, `append`) appropriate to your warehouse.

5. **Add tests in schema.yml.** At minimum, every model exposes a primary key tested with
   `unique` + `not_null`. Use `accepted_values` for enumerated columns and `relationships` to
   enforce foreign keys against the parent model. Document columns while you are there.

6. **Factor repetition into macros.** When the same SQL pattern appears in 3+ models (cents→dollars,
   timezone normalization, surrogate keys), extract a macro in `macros/`. Prefer the
   `dbt_utils` package for common needs (`generate_surrogate_key`, `star`, `pivot`) before
   writing your own.

7. **Verify before shipping.** Run `dbt build --select state:modified+` (or the specific model
   and its children) so models **and** their tests run together. For incremental changes, test
   both an incremental run and a `--full-refresh` run.

## Examples

### Example 1 — Staging model + schema.yml

`models/staging/stripe/stg_stripe__payments.sql`:

```sql
with source as (

    select * from {{ source('stripe', 'payments') }}

),

renamed as (

    select
        id                       as payment_id,
        orderid                  as order_id,
        paymentmethod            as payment_method,
        status,
        -- amount is stored in cents in the raw feed; expose dollars downstream
        amount / 100.0           as amount,
        created                  as created_at

    from source
    where _deleted_at is null

)

select * from renamed
```

`models/staging/stripe/_stripe__models.yml`:

```yaml
version: 2

models:
  - name: stg_stripe__payments
    description: "One row per Stripe payment, cleaned and typed from the raw feed."
    columns:
      - name: payment_id
        description: "Primary key of the payment."
        tests:
          - unique
          - not_null
      - name: order_id
        tests:
          - not_null
          - relationships:
              to: ref('stg_jaffle_shop__orders')
              field: order_id
      - name: payment_method
        tests:
          - accepted_values:
              values: ['credit_card', 'bank_transfer', 'coupon', 'gift_card']
      - name: status
        tests:
          - not_null
          - accepted_values:
              values: ['success', 'pending', 'failed', 'refunded']
```

### Example 2 — Incremental fact model

`models/marts/finance/fct_payments.sql`:

```sql
{{
    config(
        materialized='incremental',
        unique_key='payment_id',
        incremental_strategy='merge',
        on_schema_change='append_new_columns'
    )
}}

with payments as (

    select * from {{ ref('stg_stripe__payments') }}

    {% if is_incremental() %}
        -- only scan rows newer than what we already loaded.
        -- {{ this }} resolves to the existing target table.
        where created_at > (select coalesce(max(created_at), '1900-01-01') from {{ this }})
    {% endif %}

)

select
    payment_id,
    order_id,
    payment_method,
    status,
    amount,
    created_at
from payments
```

Run it incrementally with `dbt run --select fct_payments`. When the transformation logic
changes (not just new data), rebuild the whole table with
`dbt run --select fct_payments --full-refresh`.

## Common errors

- **Incremental model with no `unique_key`.** New runs `append` matching rows and you get
  duplicates on reprocessed/late-arriving data. Always set `unique_key` and a `merge` /
  `delete+insert` strategy when rows can be updated.
- **Forgetting `is_incremental()` around the filter.** On the first run (and every
  `--full-refresh`) the table does not exist yet; an unguarded `{{ this }}` reference fails.
  Wrap the high-watermark predicate in `{% if is_incremental() %}`.
- **Treating `--full-refresh` as routine.** A full refresh rescans the entire source and
  rebuilds the table — the exact cost incremental models exist to avoid. Use it only when logic
  or schema changed, not as a habit.
- **Circular references.** Two models `ref()`-ing each other (directly or through an
  intermediate) make the DAG impossible to order; `dbt` errors with a dependency cycle. Break
  the loop by extracting shared logic into a separate upstream model.
- **Querying raw tables directly or hardcoding schemas.** Using `source()` outside staging, or
  writing `analytics.public.payments` in a model body, destroys lineage and breaks dev/prod
  swaps. Raw → `source()` in staging only; everything else → `ref()`.
- **Skipping the primary-key test.** Without `unique` + `not_null` on the key, silent fan-out
  from a bad join goes unnoticed until a downstream metric doubles. Test every model's grain.
- **Stale `unique_key` after a grain change.** If you change what a row represents but leave the
  old `unique_key`, the merge collapses or duplicates rows. Re-check the key whenever the grain
  changes, and `--full-refresh` once after the change.
- **Over-materializing as `table`.** Defaulting staging/intermediate to `table` wastes storage
  and build time. Keep them `view`/`ephemeral` and reserve `table`/`incremental` for marts.
```
