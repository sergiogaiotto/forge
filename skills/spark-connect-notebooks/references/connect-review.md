# Spark Connect Review

## Compatibility gate

| Request or API | Connect lane |
|---|---|
| Spark SQL, DataFrame, catalog tables | Use |
| `spark.remote` or `sc://...` | Use |
| `pyspark-client` without local JRE | Use |
| Structured Streaming through supported server APIs | Use with checkpoint review |
| `SparkContext`, `parallelize`, accumulators | Route to classic |
| `.rdd`, custom `Partitioner`, pair RDD operations | Route to classic |
| `_jdf`, `_jsc`, direct JVM package calls | Route to classic or redesign |
| Driver-side library requiring all rows | Aggregate and bound first |

## Plan review

1. Confirm predicate and projection pushdown at the source.
2. Identify every `Exchange` and explain why the shuffle is necessary.
3. Verify join cardinality and duplicate-key behavior before choosing broadcast.
4. Check that Python UDFs are absent or justified.
5. Inspect adaptive execution and skew handling on the server.
6. Bound every action that returns rows to the client.
7. Record the input snapshot or table version when reproducibility matters.

## Failure diagnosis

- Serialization or protocol failure: compare client/server Spark compatibility.
- Unsupported operation: look for classic-only API or JVM/private field access.
- Driver/client memory failure: locate `collect`, `toPandas`, or oversized rich
  notebook output.
- Slow query: capture the formatted plan and server-side execution metrics.
- Different result after rerun: inspect source version, timezone,
  nondeterministic functions, ordering, random seeds, and mutable temporary views.
