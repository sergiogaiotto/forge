---
name: spark-pipelines
description: >-
  Write and optimize PySpark batch/streaming pipelines: DataFrame API, partitioning,
  joins, broadcast, caching and skew handling. Use whenever the user works with PySpark,
  Spark SQL, Delta tables, or large-scale distributed data processing.
license: Apache-2.0
metadata:
  author: claro-data-platform
  version: "1.0"
validators:
  - id: ruff
    label: ruff
    command: "ruff check {file}"
    gate: false
    appliesTo: [".py"]
---

# Spark Pipelines

**Every shuffle you did not plan is a bill you did not approve.**

Senior-level guidance for writing and tuning PySpark pipelines (batch and structured
streaming) using the DataFrame / Spark SQL API. The goal is correct, scalable code that
minimizes shuffles, keeps work on the executors, and degrades gracefully under skew.

## Critical rules

- **ALWAYS discover conventions first.** Read 2–3 existing jobs in the repo before writing one:
  imitate session builders, config profiles, IO wrappers and naming. Do not introduce a new
  pattern (RDDs, pandas-on-Spark, another writer) when the project already has one.
- **ALWAYS verify with real output, not absence of errors.** The ladder: code runs → `df.explain()`
  shows the plan you intended (no surprise shuffles/cartesian) → row counts at each stage are
  plausible → ONE record recomputed by hand matches. Lazy evaluation means "it ran" proves little.
- **NEVER collect to the driver as a fix.** `collect()`/`toPandas()` on big data moves the problem
  to a smaller machine. Aggregate/sample on executors first.
- **NEVER change partitioning/checkpointing of a production streaming job casually** — state and
  reprocessing semantics depend on it; treat it as a migration with a plan.
- **Three-failure rule.** If a stage fails 3+ times (OOM/skew/timeout), stop tweaking one config
  at a time: read the Spark UI for the REAL bottleneck (skewed key? spill? tiny files?) and fix
  the cause, not the symptom.

## When to use

Use this skill whenever the task involves any of the following:

- Authoring or refactoring **PySpark** (`pyspark.sql`) batch or streaming jobs.
- Writing **Spark SQL** or DataFrame transformations against large datasets.
- Reading from / writing to **Delta Lake**, Parquet, or other distributed tables.
- Diagnosing performance problems: slow stages, OOM on the driver or executors,
  long shuffles, stragglers caused by **data skew**.
- Deciding between `repartition` vs `coalesce`, when to **broadcast** a join side,
  when to `cache`/`persist`, and how to avoid pulling data to the driver.

Do **not** reach for low-level RDD APIs unless you genuinely need fine-grained control
that the DataFrame API cannot express — the Catalyst optimizer and Tungsten execution
engine only kick in for DataFrames/Datasets and Spark SQL.

## Steps

1. **Start from the DataFrame API, not RDDs.** DataFrames give you Catalyst optimization,
   predicate/projection pushdown, and whole-stage codegen for free. RDD `map`/`filter`
   are opaque to the optimizer.
2. **Read narrow.** Select only the columns you need and push filters as early as
   possible so the source format (Parquet/Delta) can prune row groups and partitions.
3. **Understand lazy evaluation.** Transformations (`select`, `filter`, `join`,
   `groupBy`, `withColumn`) build a logical plan and do nothing until an **action**
   (`write`, `count`, `collect`, `show`, `foreach`) triggers a job. Chain
   transformations; trigger exactly one action per materialization you actually need.
4. **Control partitioning deliberately.**
   - Use `repartition(n, col)` to *increase* parallelism or to redistribute by a key
     before a wide operation (it triggers a full shuffle).
   - Use `coalesce(n)` to *reduce* the number of output files without a full shuffle
     (it only merges existing partitions).
   - Tune `spark.sql.shuffle.partitions` (default 200) to roughly match the data volume
     and cluster cores; enable Adaptive Query Execution (AQE) to let Spark coalesce
     shuffle partitions automatically.
5. **Prefer broadcast joins for small dimensions.** If one side fits in executor memory
   (tens to low hundreds of MB), wrap it in `broadcast()` (or rely on
   `spark.sql.autoBroadcastJoinThreshold`) to avoid shuffling the large side.
6. **Cache only when reused.** `cache()`/`persist()` a DataFrame that is read by multiple
   downstream actions; otherwise caching just wastes memory. Pick a `StorageLevel`
   (`MEMORY_AND_DISK` is the safe default) and `unpersist()` when done.
7. **Handle skew explicitly.** Detect skew via the Spark UI (one task far slower than the
   rest). Mitigate with AQE skew join handling (`spark.sql.adaptive.skewJoin.enabled`)
   or, when that is insufficient, **salt** the hot keys (see Examples).
8. **Keep computation on executors.** Use built-in `pyspark.sql.functions` instead of
   Python UDFs; never `collect()` a large DataFrame to the driver. Write results back to
   storage in a distributed way.
9. **Use built-ins over UDFs.** A Python UDF serializes each row to the Python worker and
   back, defeating codegen. If you must use Python logic, prefer **pandas (vectorized)
   UDFs** over row-at-a-time UDFs.
10. **Persist with Delta for reliability.** Use Delta Lake for ACID writes, schema
    enforcement, time travel, and efficient upserts (`MERGE`). Partition output by
    low-cardinality columns and run `OPTIMIZE`/compaction to control small-file growth.

## Examples

### Example 1 — Partitioned aggregation written to Delta

Aggregate large event data by day and country, then write the result partitioned by date
so downstream readers can prune partitions. Filters and column pruning happen first to
keep the shuffle small; `coalesce` limits the number of output files.

```python
from pyspark.sql import SparkSession
from pyspark.sql import functions as F

spark = (
    SparkSession.builder
    .appName("daily-events-agg")
    .config("spark.sql.adaptive.enabled", "true")
    .config("spark.sql.shuffle.partitions", "400")
    .getOrCreate()
)

events = (
    spark.read.format("delta").load("/data/lake/events")
    # Project early: read only the columns we need.
    .select("event_ts", "country", "user_id", "amount")
    # Filter early so Delta/Parquet can prune partitions and row groups.
    .filter(F.col("event_ts") >= F.lit("2026-01-01"))
    .withColumn("event_date", F.to_date("event_ts"))
)

daily = (
    events
    .groupBy("event_date", "country")
    .agg(
        F.count("*").alias("event_count"),
        F.countDistinct("user_id").alias("unique_users"),
        F.sum("amount").alias("total_amount"),
    )
)

(
    daily
    # Reduce output files without a full shuffle (we already shuffled in groupBy).
    .coalesce(16)
    .write
    .format("delta")
    .mode("overwrite")
    .partitionBy("event_date")
    .save("/data/lake/agg/daily_events")
)
```

### Example 2 — Broadcast join of a large fact with a small dimension

The `users` dimension is small enough to fit in executor memory, so we broadcast it and
avoid shuffling the multi-billion-row `transactions` fact. `broadcast()` is an explicit
hint; it overrides the auto-broadcast threshold for this join.

```python
from pyspark.sql import SparkSession
from pyspark.sql import functions as F
from pyspark.sql.functions import broadcast

spark = SparkSession.builder.appName("enrich-transactions").getOrCreate()

transactions = (
    spark.read.format("delta").load("/data/lake/transactions")
    .select("txn_id", "user_id", "amount", "txn_ts")
)

# Small dimension table (e.g., a few hundred MB or less).
users = (
    spark.read.format("delta").load("/data/lake/dim_users")
    .select("user_id", "country", "segment")
)

enriched = (
    transactions.join(
        broadcast(users),          # ship `users` to every executor; no fact shuffle
        on="user_id",
        how="left",
    )
    .withColumn("amount_usd", F.col("amount") * F.lit(1.0))
)

(
    enriched
    .write
    .format("delta")
    .mode("overwrite")
    .save("/data/lake/transactions_enriched")
)
```

### Bonus — Salting a skewed join key

When one key dominates (e.g., a `null`/`unknown` user or a mega-merchant), a normal
shuffle join sends all matching rows to a single task. Salting spreads the hot key across
`N` reducers by appending a random suffix on the large side and exploding the small side
to match.

```python
from pyspark.sql import functions as F

N = 16  # salt buckets for the hot side

# Large/skewed side: attach a random salt 0..N-1.
fact_salted = transactions.withColumn(
    "salt", (F.rand() * N).cast("int")
)

# Small side: replicate each row across all salt values.
dim_exploded = (
    users
    .withColumn("salt", F.explode(F.array(*[F.lit(i) for i in range(N)])))
)

joined = fact_salted.join(
    dim_exploded,
    on=["user_id", "salt"],
    how="left",
).drop("salt")
```

## Common errors

- **Wide shuffles everywhere.** `groupBy`, `join`, `distinct`, `repartition(col)`, and
  window functions trigger full shuffles. Minimize them: filter/project before the
  shuffle, broadcast small sides, and reuse a single shuffled DataFrame instead of
  re-shuffling repeatedly.
- **Collecting to the driver.** `collect()`, `toPandas()`, or `take(n)` on a large
  DataFrame pulls rows into the single driver JVM and causes driver OOM. Write to storage
  instead, or aggregate down first; only `collect()` tiny, bounded results.
- **Python UDFs instead of built-ins.** Row-at-a-time UDFs serialize every row to a
  Python worker, break Catalyst/codegen, and run far slower. Use `pyspark.sql.functions`;
  if Python is unavoidable, use vectorized **pandas UDFs**.
- **`repartition` vs `coalesce` confusion.** Calling `repartition(1)` to write one file
  forces a full shuffle through a single task; use `coalesce(1)` instead. Conversely,
  `coalesce` cannot *increase* partitions — use `repartition` when you need more
  parallelism.
- **Caching without reuse (or never unpersisting).** Caching a DataFrame used only once
  wastes memory and can trigger spills; forgetting `unpersist()` leaks cached blocks
  across a long-running job.
- **Ignoring skew.** A single straggler task that runs 10x longer than its peers is the
  classic skew signature. Enable AQE skew join handling and/or salt the hot keys rather
  than just bumping executor memory.
- **Too many / too few shuffle partitions.** Leaving `spark.sql.shuffle.partitions` at
  the default 200 produces giant partitions on big data and tiny ones on small data.
  Tune it to the data volume, or enable AQE to coalesce partitions automatically.
- **Small-file explosion.** Writing highly partitioned output without compaction creates
  millions of tiny files that cripple later reads. Coalesce before writing and run Delta
  `OPTIMIZE` / compaction regularly.
- **Unnecessary actions in loops.** Calling `count()` or `show()` repeatedly for debugging
  re-runs the whole lineage each time. Cache the intermediate result or remove the debug
  actions before production.