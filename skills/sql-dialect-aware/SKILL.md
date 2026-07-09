---
name: sql-dialect-aware
description: >-
  Write and review correct, dialect-aware SQL (PostgreSQL, BigQuery, Snowflake,
  Oracle, Spark SQL) with CTEs, window functions and safe joins. Use whenever the user
  writes SQL queries, asks about a SQL dialect, or works with .sql files or warehouse tables.
license: Apache-2.0
metadata:
  author: claro-data-platform
  version: "1.0"
validators:
  - id: sqlfluff
    label: sqlfluff
    command: "sqlfluff lint --dialect ansi {file}"
    gate: false
    appliesTo: [".sql"]
---

# SQL Dialect-Aware Authoring & Review

**When in doubt, don't change semantics: keep the original and say why.**

Write SQL that runs correctly on the *target* warehouse the first time. The same
logical query is spelled differently across PostgreSQL, BigQuery, Snowflake,
Oracle and Spark SQL. This skill keeps those differences front-of-mind and pushes
toward readable, NULL-safe, join-explicit query construction.

## Critical rules

- **ALWAYS preserve semantics when optimizing or translating.** The rewritten query must
  return exactly the same rows and columns. If you cannot GUARANTEE identical results,
  keep the original fragment and flag it with a `-- REVISAR:` comment instead of guessing.
- **NEVER rename output columns** during an optimization/translation — downstream consumers
  break silently.
- **ALWAYS confirm the target dialect first.** Unknown → ask, or default to ANSI and say so.
- **Three-failure rule.** If the query fails 3+ times against the engine, stop patching
  token-by-token: re-read the full error, check the actual table schema, reassess the approach.

## Safe vs. unsafe rewrites (semantic preservation)

| CAN rewrite safely | Why it is safe |
|---|---|
| Function-on-column filter → equivalent range (`WHERE DATE(ts) = '2026-01-01'` → `ts >= '2026-01-01' AND ts < '2026-01-02'`) | Same rows, restores index/partition pruning |
| Repeated scalar subquery → CTE | Same value, evaluated once |
| Implicit join (`FROM a, b WHERE …`) → explicit `JOIN … ON` | Same predicate, clearer and safer |
| `NOT IN (SELECT col …)` → `NOT EXISTS` **only if** the subquery column is provably NOT NULL | Removes the NULL trap without changing results on non-NULL data |

| CANNOT rewrite (without explicit user approval) | Why it is unsafe |
|---|---|
| `UNION` → `UNION ALL` | Changes results whenever duplicates exist |
| Adding/removing `DISTINCT` or changing dedup logic (`ROW_NUMBER` filters) | Changes the row set |
| Touching window function frames (`ROWS`/`RANGE`, `ORDER BY` inside `OVER`) | Subtle result changes, especially with ties |
| Reordering `LIMIT` without a deterministic `ORDER BY` | Different rows may be returned |
| "Simplifying" `COALESCE`/`NVL` chains on nullable columns | NULL handling is usually intentional |

## When to use

Use this skill whenever you:

- Write or modify SQL in `.sql` files, notebooks, dbt models, or inline strings.
- Are asked "how do I do X in BigQuery / Snowflake / Oracle / Spark SQL / Postgres".
- Review a query for correctness (joins, NULLs, dedup, ranking, pagination).
- Port a query from one engine to another and need to translate dialect-specific syntax.
- Touch warehouse tables and need row-limiting, date math, or string handling that
  behaves identically to what the author intended.

Always confirm the **target dialect first**. If it is unknown, ask or default to
ANSI-compatible constructs and call out the assumption.

## Dialect cheat-sheet

| Concern | PostgreSQL | BigQuery | Snowflake | Oracle | Spark SQL |
|---|---|---|---|---|---|
| Row limit | `LIMIT n` / `OFFSET k` | `LIMIT n` | `LIMIT n` / `FETCH FIRST n ROWS ONLY` | `FETCH FIRST n ROWS ONLY` (12c+) or `ROWNUM <= n` | `LIMIT n` |
| "Top n" keyword | none (use `LIMIT`) | none | `TOP n` (also `LIMIT`) | none (use `FETCH`/`ROWNUM`) | none |
| Current timestamp | `now()` / `current_timestamp` | `CURRENT_TIMESTAMP()` | `CURRENT_TIMESTAMP()` | `SYSTIMESTAMP` / `CURRENT_TIMESTAMP` | `current_timestamp()` |
| Date add | `dt + INTERVAL '1 day'` | `DATE_ADD(dt, INTERVAL 1 DAY)` | `DATEADD(day, 1, dt)` | `dt + 1` or `dt + INTERVAL '1' DAY` | `date_add(dt, 1)` |
| Date diff (days) | `d2 - d1` | `DATE_DIFF(d2, d1, DAY)` | `DATEDIFF(day, d1, d2)` | `d2 - d1` | `datediff(d2, d1)` |
| Truncate to month | `date_trunc('month', dt)` | `DATE_TRUNC(dt, MONTH)` | `DATE_TRUNC('month', dt)` | `TRUNC(dt, 'MM')` | `date_trunc('month', dt)` |
| String concat | `a \|\| b` or `concat(a,b)` | `CONCAT(a,b)` (`\|\|` also works) | `a \|\| b` or `CONCAT(a,b)` | `a \|\| b` or `CONCAT(a,b)` (2 args) | `concat(a,b)` (`\|\|` in 3.x) |
| `QUALIFY` (filter on window) | not supported (wrap in CTE) | supported | supported | not supported (wrap in CTE) | supported (3.x) |
| NULL-safe equality | `a IS NOT DISTINCT FROM b` | `a IS NOT DISTINCT FROM b` | `EQUAL_NULL(a,b)` / `IS NOT DISTINCT FROM` | `DECODE(a,b,1,0)=1` / nvl pattern | `a <=> b` |
| Identifier quoting | `"col"` | `` `col` `` | `"col"` | `"col"` | `` `col` `` |
| Boolean type | native `boolean` | native `BOOL` | native `BOOLEAN` | no boolean (use `0/1`/`CHAR`) | native `boolean` |

Notes that bite people:

- **`||` is not concat everywhere.** In Oracle/Postgres/Snowflake it concatenates;
  in standard BigQuery use `CONCAT`. `CONCAT(NULL, x)` returns `NULL` in some engines
  and skips NULLs in others — prefer `COALESCE` around nullable inputs.
- **`QUALIFY` only exists in BigQuery, Snowflake and Spark 3.x.** For Postgres/Oracle,
  compute the window in a CTE and filter in the outer query.
- **Oracle has no native boolean** in SQL (only in PL/SQL), and `''` is treated as
  `NULL` — `WHERE col = ''` never matches.
- **`ROWNUM` is assigned before `ORDER BY`** in Oracle. `WHERE ROWNUM <= 10 ORDER BY x`
  does *not* give the top 10 by `x`; rank in a subquery/CTE first, then filter.

## Steps

1. **Pin the dialect.** Establish the target engine (and version for Oracle/Spark).
   Pick syntax from the cheat-sheet accordingly; note any assumption explicitly.
2. **Model with CTEs, not nested subqueries.** Break logic into named `WITH` steps
   (`source`, `filtered`, `ranked`, `final`). It reads top-to-bottom and each step is
   independently inspectable. Avoid deeply nested inline subqueries.
3. **Make every join explicit.** Always `JOIN ... ON` (or `USING`). Never list tables
   comma-separated in `FROM` — that is an implicit cross join waiting to explode row
   counts. State the join *type* (`INNER`/`LEFT`/...) deliberately.
4. **Guard the grain.** Before joining, know the intended row grain. If a join key can
   be duplicated, dedup the right side first (see Example 2) so you don't fan out rows.
5. **Use window functions for ranking/dedup/running totals** instead of self-joins or
   correlated subqueries: `ROW_NUMBER`, `RANK`, `DENSE_RANK`, `LAG`/`LEAD`,
   `SUM(...) OVER (...)`. Filter on them with `QUALIFY` (where supported) or a CTE.
6. **Be NULL-safe.** `=`/`<>` return `NULL` (not `TRUE`/`FALSE`) when either side is
   `NULL`, so rows silently drop. Use `IS NOT DISTINCT FROM` / `<=>` / `EQUAL_NULL`,
   or `COALESCE` both sides to a sentinel before comparing. `NOT IN (subquery)` is a
   classic trap when the subquery yields any `NULL` — prefer `NOT EXISTS`.
7. **Limit/paginate per dialect.** Use `LIMIT`/`FETCH FIRST`/`ROWNUM` from the table.
   Pair pagination with a deterministic `ORDER BY` on a unique key — otherwise results
   are not stable across pages.
8. **Qualify columns and alias tables** in any multi-table query to prevent ambiguity
   and to keep the query valid as schemas evolve.
9. **Lint before shipping.** Run `sqlfluff lint --dialect <dialect> file.sql` (the bundled
   validator uses `ansi`; pass the real dialect when you know it) and resolve findings.

## Examples

### Example 1 — Window-function ranking (top N per group)

Rank salespeople by revenue *within each region* and keep the top 3. Uses `QUALIFY`
on engines that support it; falls back to a CTE elsewhere.

BigQuery / Snowflake / Spark SQL (with `QUALIFY`):

```sql
SELECT
    region,
    sales_rep,
    total_revenue,
    RANK() OVER (
        PARTITION BY region
        ORDER BY total_revenue DESC
    ) AS revenue_rank
FROM sales_by_rep
QUALIFY revenue_rank <= 3
ORDER BY region, revenue_rank;
```

PostgreSQL / Oracle (no `QUALIFY` — rank in a CTE, filter outside):

```sql
WITH ranked AS (
    SELECT
        region,
        sales_rep,
        total_revenue,
        RANK() OVER (
            PARTITION BY region
            ORDER BY total_revenue DESC
        ) AS revenue_rank
    FROM sales_by_rep
)
SELECT
    region,
    sales_rep,
    total_revenue,
    revenue_rank
FROM ranked
WHERE revenue_rank <= 3
ORDER BY region, revenue_rank;
```

### Example 2 — Deduplicate rows with `ROW_NUMBER` (keep latest per key)

Collapse a table that has multiple rows per `customer_id` down to one row: the most
recent by `updated_at`, breaking ties on the surrogate `event_id` for determinism.

```sql
WITH ordered AS (
    SELECT
        customer_id,
        email,
        updated_at,
        event_id,
        ROW_NUMBER() OVER (
            PARTITION BY customer_id
            ORDER BY updated_at DESC, event_id DESC
        ) AS rn
    FROM customer_events
)
SELECT
    customer_id,
    email,
    updated_at,
    event_id
FROM ordered
WHERE rn = 1;
```

On BigQuery / Snowflake / Spark you can compress this with `QUALIFY` and skip the
outer query:

```sql
SELECT
    customer_id,
    email,
    updated_at,
    event_id
FROM customer_events
QUALIFY ROW_NUMBER() OVER (
    PARTITION BY customer_id
    ORDER BY updated_at DESC, event_id DESC
) = 1;
```

Use `RANK()`/`DENSE_RANK()` instead of `ROW_NUMBER()` only when you intend to keep
*all* tied rows; `ROW_NUMBER()` guarantees exactly one row per partition.

## Common errors

- **Implicit cross join:** comma-separated tables in `FROM` with the join condition
  buried in `WHERE` (or missing). Always write `JOIN ... ON`.
- **Row fan-out:** joining to a non-unique key multiplies rows and inflates `SUM`/
  `COUNT`. Dedup or pre-aggregate the right side; verify the post-join grain.
- **`NOT IN` with NULLs:** if the subquery returns any `NULL`, `NOT IN` yields zero rows.
  Use `NOT EXISTS` or filter the NULLs out of the subquery.
- **`=` against NULL:** equality/inequality with `NULL` is `UNKNOWN`, so matching rows
  vanish. Use `IS NOT DISTINCT FROM`, `<=>`, `EQUAL_NULL`, or `COALESCE` both sides.
- **`QUALIFY` on an unsupported engine:** Postgres/Oracle reject it — move the window
  filter into a CTE.
- **`ROWNUM` before `ORDER BY` (Oracle):** `WHERE ROWNUM <= n ORDER BY x` filters the
  *unsorted* rows. Rank in a subquery/CTE, then apply the limit.
- **Wrong concat operator:** `||` is not string concatenation in standard BigQuery;
  use `CONCAT`. And `CONCAT`/`||` may propagate or skip `NULL` differently per engine.
- **Empty string vs NULL (Oracle):** `''` is `NULL`, so `col = ''` never matches and
  `col IS NULL` is what you actually want.
- **Unstable pagination:** `LIMIT`/`OFFSET` (or `FETCH`) without a deterministic
  `ORDER BY` on a unique key returns arbitrary, overlapping pages.
- **Integer division surprise:** in Postgres/Oracle `5 / 2 = 2`; cast a side to a
  decimal/float (`5 * 1.0 / 2`) when you need a fractional result.
- **Ambiguous / unqualified columns:** in multi-table queries, alias tables and
  qualify columns so the query stays valid and unambiguous as schemas change.
