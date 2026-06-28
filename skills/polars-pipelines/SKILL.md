---
name: polars-pipelines
description: >-
  Author fast, lazy Polars pipelines (scan_*, expressions, group_by, joins, window
  functions) and translate pandas idioms to Polars. Use whenever the user works with
  Polars DataFrames/LazyFrames or needs high-performance columnar transforms in Python.
license: Apache-2.0
metadata:
  author: claro-data-platform
  version: "1.0"
validators:
  - id: ruff
    label: ruff
    command: "ruff check {file}"
    gate: true
    appliesTo: [".py"]
---

# Polars pipelines

Write idiomatic, high-performance Polars. Prefer the **lazy API** (`LazyFrame`) so the
query optimizer can do predicate/projection pushdown, common-subexpression elimination,
and (optionally) streaming execution. Build transforms with the **expression API**
(`pl.col(...)`, `when/then/otherwise`, `.over(...)`) instead of Python loops or
row-wise `apply`. Materialize with a single `.collect()` at the end.

## When to use

- The user is working with `pl.DataFrame` / `pl.LazyFrame`, or reads Parquet/CSV/NDJSON
  with `scan_*` / `read_*`.
- A pandas pipeline needs to be ported to Polars, or a pandas idiom needs a Polars
  translation (`groupby`, `merge`, `assign`, `transform`, `rolling`, `shift`).
- A dataset is too large for memory and needs **streaming** (`.collect(engine="streaming")`).
- Existing Polars code is slow because it mixes eager and lazy work, calls `apply`
  per row, or collects intermediate frames repeatedly.
- You need correct, optimizer-friendly group-by aggregations, joins, or window
  (`over`) features such as group ranks, lags, or running totals.

## Steps

1. **Scan, don't read.** Start the pipeline with `pl.scan_parquet`/`pl.scan_csv`
   (lazy) rather than `pl.read_*` (eager). This enables projection and predicate
   pushdown so only needed columns/rows are touched.
2. **Express transforms with `pl.col` expressions.** Chain `.select`, `.with_columns`,
   `.filter`, `.group_by(...).agg(...)`, `.join(...)`. Use `pl.when(...).then(...).otherwise(...)`
   for conditional logic. Never use `.apply`/`map_elements` unless there is genuinely no
   vectorized expression.
3. **Filter early, project narrow.** Put `.filter(...)` and column selection as high in
   the chain as possible; the optimizer pushes them down, but explicit narrowing keeps
   intent clear and avoids surprises.
4. **Aggregate with `group_by().agg([...])`.** Pass a list of named expressions;
   alias every output (`.alias(...)`) so column names are deterministic.
5. **Use window functions via `.over(...)`** for per-group computations that must keep
   the original row count (ranks, lags, group shares) instead of an aggregate join.
6. **Be explicit about dtypes.** Cast on ingest (`.cast(pl.Int64)`, `schema_overrides=...`,
   `try_parse_dates=True`) to avoid silent `Utf8`/`Int64`/`Float64` surprises. Parse
   dates/timestamps explicitly.
7. **Collect once.** End with `.collect()`. For data larger than memory, use
   `.collect(engine="streaming")`. Inspect the plan with `.explain()` before collecting
   on expensive jobs.
8. **Validate.** Run `ruff check` on the resulting `.py` file; keep imports clean and
   avoid leftover eager round-trips.

## Examples

### Example 1 — Lazy aggregation pipeline (scan + filter + group_by + collect)

```python
import polars as pl

# Lazy scan: only the referenced columns and matching rows are read.
sales = pl.scan_parquet("data/sales/*.parquet")

revenue_by_region = (
    sales
    .filter(pl.col("order_date").is_between(pl.date(2025, 1, 1), pl.date(2025, 12, 31)))
    .filter(pl.col("status") == "completed")
    .with_columns(
        (pl.col("unit_price") * pl.col("quantity")).alias("line_revenue"),
    )
    .group_by("region", "product_category")
    .agg(
        pl.col("line_revenue").sum().alias("total_revenue"),
        pl.col("order_id").n_unique().alias("n_orders"),
        pl.col("line_revenue").mean().alias("avg_line_revenue"),
        pl.col("quantity").sum().alias("units_sold"),
    )
    .sort("total_revenue", descending=True)
    .collect()  # single materialization; use engine="streaming" if it exceeds RAM
)

print(revenue_by_region)
```

### Example 2 — Window-function feature engineering (`.over(...)`)

```python
import polars as pl

events = pl.scan_csv("data/events.csv", try_parse_dates=True)

features = (
    events
    .sort("user_id", "event_time")
    .with_columns(
        # Per-user running total (cumulative sum within each user partition).
        pl.col("amount").cum_sum().over("user_id").alias("user_cumulative_amount"),
        # Previous event amount per user (lag of 1).
        pl.col("amount").shift(1).over("user_id").alias("prev_amount"),
        # Dense rank of each event by amount within the user.
        pl.col("amount").rank(method="dense", descending=True)
            .over("user_id").alias("amount_rank_in_user"),
        # Share of this row's amount relative to the user's total.
        (pl.col("amount") / pl.col("amount").sum().over("user_id"))
            .alias("amount_share_of_user"),
    )
    .with_columns(
        (pl.col("amount") - pl.col("prev_amount")).alias("amount_delta"),
    )
    .collect()
)

print(features)
```

## pandas → Polars translation table

| pandas | Polars |
| --- | --- |
| `pd.read_parquet("f")` | `pl.scan_parquet("f")` (lazy) / `pl.read_parquet("f")` (eager) |
| `df[df.x > 0]` | `df.filter(pl.col("x") > 0)` |
| `df["y"] = df.a + df.b` | `df.with_columns((pl.col("a") + pl.col("b")).alias("y"))` |
| `df.assign(y=...)` | `df.with_columns(...)` |
| `df.groupby("k").agg({"v": "sum"})` | `df.group_by("k").agg(pl.col("v").sum())` |
| `df.merge(o, on="k", how="left")` | `df.join(o, on="k", how="left")` |
| `df["v"].shift(1)` | `pl.col("v").shift(1)` (add `.over("k")` per group) |
| `df.groupby("k")["v"].transform("sum")` | `pl.col("v").sum().over("k")` |
| `df["v"].rolling(3).mean()` | `pl.col("v").rolling_mean(window_size=3)` |
| `np.where(cond, a, b)` | `pl.when(cond).then(a).otherwise(b)` |
| `df.rename(columns={"a": "b"})` | `df.rename({"a": "b"})` |
| `df.sort_values("v", ascending=False)` | `df.sort("v", descending=True)` |
| `df["v"].astype("int64")` | `pl.col("v").cast(pl.Int64)` |
| `df.fillna(0)` | `df.fill_null(0)` |
| `df.drop_duplicates(subset=["k"])` | `df.unique(subset=["k"])` |

## Common errors

- **Forgetting `.collect()`.** A lazy chain returns a `LazyFrame` describing a plan, not
  data. If you see `<LazyFrame ...>` or "naive plan" output, you forgot to call
  `.collect()` (or `.fetch(n)` while prototyping).
- **Mixing eager and lazy.** Calling `pl.read_*` then `.lazy()`, or sprinkling
  `.collect()` mid-pipeline, defeats pushdown and re-materializes data. Stay lazy from
  `scan_*` to a single final `.collect()`.
- **Row-wise `apply` / `map_elements`.** These drop to Python per element and are orders
  of magnitude slower. Replace with vectorized expressions (`pl.when`, arithmetic,
  string/date namespaces, `.over`).
- **Dtype surprises.** `scan_csv` may infer `Utf8` or `Float64` where you expect ints,
  and integer columns with nulls won't silently become floats like in pandas. Cast
  explicitly and use `try_parse_dates=True` / `schema_overrides=` on ingest.
- **`group_by` is unordered by default.** Output row order is not guaranteed; add
  `.sort(...)` if you need determinism, or use `maintain_order=True` (slower).
- **Window vs aggregation confusion.** `group_by().agg(...)` collapses rows;
  `expr.over(...)` keeps the original row count. Use `.over(...)` when you need a
  per-group value attached to every row.
- **Null handling differs from NaN.** Polars distinguishes `null` (missing) from `NaN`
  (float). Use `.fill_null(...)` / `.is_null()` for missing data and `.fill_nan(...)` /
  `.is_nan()` only for float NaNs.
- **Comparing to pandas index behavior.** Polars has no index; operations that relied on
  pandas alignment by index must be rewritten as explicit joins on key columns.
- **Out-of-memory on `.collect()`.** For datasets larger than RAM, use
  `.collect(engine="streaming")` and avoid eager `read_*` at the source.
