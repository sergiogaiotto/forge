# Classic Spark SQL and RDD Review

## API selection

| Need | Preferred API |
|---|---|
| Filters, joins, windows, aggregation | Spark SQL or DataFrame |
| Catalog or lakehouse table access | Spark SQL or DataFrame |
| Irregular record parsing | Narrow RDD segment |
| Partition-local client or parser initialization | `mapPartitions` |
| Key aggregation | `reduceByKey` or `aggregateByKey` |
| Custom key distribution | Pair RDD plus justified `partitionBy` |
| Typed result consumed by SQL | Convert RDD to DataFrame with explicit schema |
| RDD requested only by habit | Keep DataFrame or SQL |

## Safe boundary recipe

1. Filter and project with DataFrames before `.rdd`.
2. Record partition count and estimated volume.
3. Keep the RDD function pure unless side effects are explicitly idempotent.
4. Emit tuples or Rows matching a declared schema.
5. Convert back with `spark.createDataFrame(rdd, schema)`.
6. Validate malformed-record policy and rejected-record counts.
7. Continue joins and aggregation through SQL or DataFrames.

## Production checklist

- Confirm compatible Python, Spark, JVM, and connector versions.
- Confirm Kryo or Java serializer choices for JVM objects where applicable.
- Check executor memory, cores, shuffle partitions, and dynamic allocation.
- Detect hot keys with per-partition counts, not only global counts.
- Ensure broadcast values fit executor memory.
- Ensure checkpoint and output paths are owned and isolated by environment.
- Ensure retries cannot duplicate external writes.
- Inspect task time, GC, spill, shuffle read/write, and Python worker overhead.
- Verify one deterministic small-data result independently.
