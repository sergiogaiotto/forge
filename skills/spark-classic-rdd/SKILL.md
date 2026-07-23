---
name: spark-classic-rdd
description: >-
  Design, debug, and tune advanced classic Apache Spark workflows that combine
  Spark SQL, DataFrames, SparkContext, and RDD APIs. Use when the user explicitly
  needs RDD transformations/actions, pair RDDs, custom partitioning, mapPartitions,
  accumulators, broadcast variables, low-level lineage, legacy PySpark jobs, or
  a local/classic Spark runtime with JVM access. Also use when converting safely
  between RDDs, DataFrames, and Spark SQL.
---

# Spark Classic SQL and RDD

Treat this as an advanced lane. Start with Spark SQL/DataFrames, descend to RDD
only for a concrete capability the structured APIs cannot express, and return
to a typed DataFrame as soon as a schema becomes available.

## Prove that RDD is warranted

Use an RDD when at least one condition is true:

- records are irregular or not yet schema-shaped;
- an existing library requires `mapPartitions` over Python objects;
- custom partitioning or pair-RDD semantics are essential;
- low-level control over partition-local initialization is required;
- the repository already owns a classic RDD architecture that must be preserved.

Do not use RDD merely for familiar `map` and `filter` syntax. Spark SQL and
DataFrames expose schema and expressions to Catalyst; Python RDD functions are
opaque and add Python/JVM serialization overhead.

## Declare the runtime

Require a classic PySpark runtime with a compatible JVM. Do not silently replace
a Connect session with local Spark.

```python
from pyspark.sql import SparkSession

spark = (
    SparkSession.builder
    .appName("forge-classic-analysis")
    .config("spark.sql.adaptive.enabled", "true")
    .getOrCreate()
)
sc = spark.sparkContext
```

Let deployment configuration choose local, standalone, YARN, or Kubernetes
master. Never hardcode `local[*]` in production code.

## Structure notebook or job

1. Document why classic Spark and RDD are necessary.
2. Record Spark, Python, JVM, serializer, and deployment assumptions.
3. Define the input grain and explicit output schema.
4. Use Spark SQL/DataFrames for loading, pruning, joins, windows, and aggregation.
5. Isolate the smallest possible RDD segment.
6. Return to a DataFrame with an explicit schema.
7. Inspect SQL plans and RDD lineage/partition counts.
8. Validate counts, keys, nulls, partition distribution, and a hand-calculated case.
9. Document retry semantics, side effects, and operational limits.

For FORGE notebook proposals, alternate `kind=markdown` and `kind=code`; tag the
RDD boundary `rdd-boundary`, expensive actions `slow`, and checks `quality`.

## Combine Spark SQL, DataFrames, and RDD

Keep structured operations in Spark SQL, convert only the narrow projection
needed by the RDD logic, and restore a schema immediately.

```python
from pyspark.sql import functions as F
from pyspark.sql.types import LongType, StringType, StructField, StructType

events = (
    spark.read.table("network.events")
    .select("subscriber_id", "event_type", "payload")
    .where(F.col("subscriber_id").isNotNull())
)

def parse_partition(rows):
    # Initialize expensive partition-local resources here, not once per row.
    for row in rows:
        normalized = normalize_payload(row.payload)
        if normalized is not None:
            yield (row.subscriber_id, row.event_type, normalized)

parsed_rdd = events.rdd.mapPartitions(parse_partition)

schema = StructType(
    [
        StructField("subscriber_id", StringType(), nullable=False),
        StructField("event_type", StringType(), nullable=False),
        StructField("normalized_value", LongType(), nullable=False),
    ]
)
parsed = spark.createDataFrame(parsed_rdd, schema=schema)
parsed.createOrReplaceTempView("parsed_events")

summary = spark.sql(
    """
    SELECT subscriber_id, event_type, SUM(normalized_value) AS total_value
    FROM parsed_events
    GROUP BY subscriber_id, event_type
    """
)
```

Never infer the schema from a production RDD sample when nullability, decimal
precision, timestamps, or nested structures matter.

## Control partitions deliberately

- Inspect `rdd.getNumPartitions()` and key distribution before tuning.
- Use `partitionBy` only for pair RDDs and with a justified partition count.
- Preserve partitioners when possible; avoid transformations that discard them.
- Use `mapPartitions` for partition-scoped setup, batching, and connection reuse.
- Do not perform external writes in plain `map` or `foreach` without idempotency:
  retries and speculative execution can repeat side effects.
- Prefer `reduceByKey` or `aggregateByKey` to `groupByKey`.
- Use `repartitionAndSortWithinPartitions` when downstream processing needs
  partition-local ordering.

## Manage closures, serialization, and shared state

- Capture small immutable values in closures.
- Broadcast large read-only lookup data rather than serializing it per task.
- Use accumulators only for diagnostics, never as business output.
- Do not capture clients, sessions, DataFrames, file handles, or SparkContext.
- Keep partition functions top-level and serializable.
- Measure serialized record size when Python/JVM transfer dominates.

## Persist and checkpoint with intent

Persist only when the same expensive lineage feeds multiple actions. Choose a
storage level based on recomputation cost and executor memory, materialize once,
and `unpersist()` after the last consumer.

Use checkpointing to truncate unstable or very long lineage, especially for
iterative algorithms. Configure durable checkpoint storage for production;
`localCheckpoint()` is not a durability mechanism.

## Review both planners

For structured portions, run `summary.explain(mode="formatted")`. For RDD
portions, inspect `rdd.toDebugString()`, partition counts, stage metrics, spill,
task duration distribution, and shuffle read/write. One view cannot explain the
entire hybrid pipeline.

## Test without a fake cluster success

- Extract pure partition functions and unit-test them with Python iterators.
- Use a small local classic Spark session for integration tests.
- Test empty partitions, malformed records, skewed keys, duplicate retries, and
  serialization failures.
- Compare the hybrid result with a small SQL/DataFrame reference implementation.
- Verify that code does not run an action once per notebook display or loop.

## Definition of done

Finish only when:

- the RDD boundary has a written justification;
- input and output schemas and grains are explicit;
- SQL/DataFrame plans and RDD lineage were both inspected;
- partitioning, skew, serialization, and retry behavior are addressed;
- side effects are idempotent or transactionally guarded;
- no unbounded `collect()` or `toPandas()` reaches the driver;
- the notebook or job runs from a fresh classic session;
- a path back to structured APIs is documented.

Read [references/classic-sql-rdd-review.md](references/classic-sql-rdd-review.md)
for conversion recipes and the production review checklist.
