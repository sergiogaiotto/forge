---
name: spark-connect-notebooks
description: >-
  Build documented Jupyter notebooks and Python analytics with Spark Connect,
  Spark SQL, and the DataFrame API against a remote Spark session. Use for
  spark.remote/sc:// endpoints, remote lakehouse exploration, distributed SQL,
  DataFrame transformations, Structured Streaming plans, lightweight PySpark
  clients, or notebook workflows that must avoid a local JRE.
---

# Spark Connect Notebooks

Use Spark Connect as the default interactive distributed-compute lane. Keep the
notebook thin, documented, restartable, and explicit about which work runs on
the cluster and which work returns to the local Python process.

## Route the request

1. Use this skill when a Connect URI, remote Spark session, notebook, Spark SQL,
   DataFrame, lakehouse, Parquet/Delta table, or distributed query is involved.
2. Stay in Spark SQL and the DataFrame API. Do not emit `SparkContext`, `.rdd`,
   `parallelize`, `_jdf`, `_jsc`, private JVM access, or RDD transformations.
3. Route explicit RDD, `SparkContext`, custom partitioner, JVM, or legacy Spark
   requests to `spark-classic-rdd`.
4. Prefer pandas, Polars, DuckDB, or Ibis when the data is local and comfortably
   fits on one machine. Do not start a distributed job merely because Spark is
   available.

## Build the notebook

Create alternating Markdown and code cells in this order:

1. Objective, data contract, expected grain, and acceptance criteria.
2. Runtime contract: endpoint source, Spark version expectation, catalog, and
   packages. Never print endpoint credentials or tokens.
3. Imports and Connect session.
4. Narrow data loading with explicit columns and early filters.
5. Data-quality assertions before business transformations.
6. Transformations expressed with built-in functions or Spark SQL.
7. Logical and physical plan inspection.
8. Bounded validation output and one manually recomputed record or aggregate.
9. Findings, limitations, cost risks, and promotion path to a versioned job.

Use `kind=markdown` for explanatory cells when emitting FORGE notebook
proposals. Tag expensive cells `slow`, parameter cells `parameters`, and
validation cells `quality`.

## Connect explicitly

Read the endpoint from configuration or environment. Never hardcode a token.

```python
import os
from pyspark.sql import SparkSession

remote = os.environ["SPARK_REMOTE"]
spark = SparkSession.builder.remote(remote).appName("forge-analysis").getOrCreate()
```

When using the pure Python client, declare `pyspark-client` and compatible
`pandas`, `pyarrow`, and `grpcio` versions in the project dependency manifest.
Do not add the full `pyspark` distribution or a JRE unless the selected runtime
actually requires the classic lane.

## Combine DataFrames and Spark SQL

Use DataFrames for composable transformations and Spark SQL when SQL is clearer
for joins, windows, aggregation, CTEs, or review by data teams.

```python
from pyspark.sql import functions as F

orders = (
    spark.read.table("sales.orders")
    .select("order_id", "customer_id", "order_ts", "amount", "status")
    .where(F.col("order_ts") >= F.lit("2026-01-01"))
)
orders.createOrReplaceTempView("orders_scope")

daily = spark.sql(
    """
    SELECT
      CAST(order_ts AS DATE) AS order_date,
      status,
      COUNT(*) AS order_count,
      SUM(amount) AS gross_amount
    FROM orders_scope
    GROUP BY CAST(order_ts AS DATE), status
    """
)
```

Do not interpolate untrusted values into SQL. Prefer DataFrame predicates,
validated identifiers, parameter markers where the backend supports them, or
small allowlists for catalog/schema/table names.

## Inspect before triggering work

Call `explain(mode="formatted")` before expensive actions. Look for:

- unexpected `Exchange` nodes or repeated shuffles;
- broadcast that is missing or unsafe for executor memory;
- filters or projections that failed to push down;
- Cartesian products;
- Python UDF boundaries;
- skewed joins and very large aggregations.

Transformations are lazy. Make actions deliberate and visible. Avoid repeated
`count()`, `show()`, and notebook display calls over the same lineage.

## Bound every local result

Never use unbounded `collect()` or `toPandas()`. Aggregate, filter, sample, and
limit on the cluster first.

```python
preview = daily.orderBy(F.desc("gross_amount")).limit(100)
local_preview = preview.toPandas()
assert len(local_preview) <= 100
```

State the bound in Markdown. Treat a local conversion as an explicit data-egress
boundary and apply PII masking before conversion.

## Validate semantics

- Assert required columns and expected types.
- Check key uniqueness at the intended grain.
- Compare input/output counts only when transformation semantics justify it.
- Check null rates and join match rates.
- Recompute one small example independently.
- For streaming, document watermark, output mode, checkpoint ownership, and
  replay behavior. Do not casually change checkpoint paths or state schemas.

## Definition of done

Finish only when the notebook:

- runs top to bottom against a fresh Connect session;
- contains no classic-only API;
- exposes no secret or unbounded local collection;
- records plan evidence for expensive work;
- validates data grain and important invariants;
- documents cluster assumptions and failure behavior;
- identifies code that should move into a tested module or job.

Read [references/connect-review.md](references/connect-review.md) when tuning a
plan, reviewing a Connect notebook, or diagnosing compatibility.
