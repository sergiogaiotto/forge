---
name: data-quality-checks
description: >-
  Define and implement data quality checks and expectations (nulls, ranges, uniqueness,
  referential integrity, freshness) with pandas/Great Expectations/Pandera. Use whenever
  the user validates datasets, writes data quality tests, or asks about data validation.
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

# Data quality checks

Validate datasets against explicit, versioned expectations so bad data is caught
*before* it propagates downstream. Treat data quality as code: declarative schemas,
thresholds, and assertions that run inside the pipeline and fail loudly.

## When to use

Use this skill whenever you:

- Add or change a data validation layer (ingestion, transformation, or pre-publish gate).
- Write data quality tests for a DataFrame, table, or file (CSV/Parquet/JDBC source).
- Need to express expectations: null rates, uniqueness/primary keys, value ranges and
  domains, referential integrity, freshness/timeliness, or distribution drift.
- Are deciding between Pandera (schema-as-types, great for in-process pandas/Polars) and
  Great Expectations (suite-based, profiling, Data Docs, warehouse-native).
- Want a pipeline to **fail fast** on a contract violation instead of silently writing
  corrupt rows.

## A taxonomy of checks

Pick checks deliberately; each maps to a failure mode.

| Dimension | Question it answers | Typical check |
| --- | --- | --- |
| Completeness | Are required values present? | null rate per column under a threshold |
| Uniqueness / PK | Are keys unique? | `nunique == len`, no duplicate PK |
| Validity (range/domain) | Are values plausible/in-domain? | `min <= x <= max`, `isin(allowed)` |
| Referential integrity | Do FKs resolve? | every FK value exists in the parent key set |
| Freshness / timeliness | Is the data recent enough? | `max(event_ts) >= now - SLA` |
| Distribution drift | Has the shape shifted? | mean/quantile/category-share within tolerance |
| Consistency | Do cross-field rules hold? | `end_date >= start_date`, `total == sum(parts)` |

## Steps

1. **Define the contract first.** List the expectations per column/table with explicit
   thresholds (e.g. "`customer_id` non-null 100%, unique; `amount` in `[0, 1e6]`;
   `email` matches regex; nulls in `phone` < 5%"). Decide what is *blocking* vs *warning*.
2. **Choose a tool.** Pandera for in-process pandas/Polars typed schemas and lazy
   validation; Great Expectations when you need suites, profiling, Data Docs, and
   warehouse execution. They compose — Pandera at transform boundaries, GE at gates.
3. **Encode nullability explicitly.** Set `nullable=False` where required; never let the
   default silently allow nulls. Distinguish "must be present" from "may be absent".
4. **Set thresholds, not just booleans.** Real data has noise; assert *rates*
   (`null_rate < 0.01`) rather than zero-tolerance unless the column is truly mandatory.
5. **Validate at the boundary, fail fast.** Run validation immediately after a source is
   read and before it is written. Raise on blocking failures so the bad batch never lands.
6. **Capture and surface results.** Log the failing rows/columns and counts; emit metrics
   and (for GE) Data Docs so failures are debuggable, not just "exit code 1".
7. **Test the checks themselves.** Feed known-good and known-bad fixtures to confirm the
   schema accepts valid data and rejects each violation class.

## Examples

### 1. Pandera `DataFrameSchema` with nullability, ranges, uniqueness, and cross-field rules

```python
"""Validate a transactions DataFrame with a typed Pandera schema."""
from __future__ import annotations

import pandas as pd
import pandera.pandas as pa
from pandera import Check, Column
from pandera.errors import SchemaErrors

ALLOWED_STATUS = ("pending", "settled", "refunded", "failed")

schema = pa.DataFrameSchema(
    columns={
        # Completeness + uniqueness: primary key, never null, unique.
        "transaction_id": Column(str, nullable=False, unique=True),
        # Referential key: required, but uniqueness not enforced here.
        "customer_id": Column(str, nullable=False),
        # Validity / range: non-negative, bounded.
        "amount": Column(
            float,
            checks=Check.in_range(0.0, 1_000_000.0, include_min=True, include_max=True),
            nullable=False,
        ),
        # Domain check via allowed set.
        "status": Column(str, checks=Check.isin(ALLOWED_STATUS), nullable=False),
        # Nullability made explicit: phone may legitimately be missing.
        "phone": Column(str, nullable=True, required=False),
        # Freshness handled at the column level: parseable timestamp, not in the future.
        "event_ts": Column(
            "datetime64[ns]",
            checks=Check(lambda s: s <= pd.Timestamp.utcnow().tz_localize(None),
                         error="event_ts must not be in the future"),
            nullable=False,
        ),
    },
    # Cross-field consistency rule evaluated on the whole frame.
    checks=Check(
        lambda df: (df["status"] != "refunded") | (df["amount"] > 0),
        error="refunded transactions must have a positive amount",
    ),
    strict=True,   # reject unexpected columns
    coerce=True,   # coerce dtypes where safe
)


def validate_transactions(df: pd.DataFrame) -> pd.DataFrame:
    """Return the validated frame or raise with every failure collected."""
    try:
        return schema.validate(df, lazy=True)
    except SchemaErrors as exc:
        # exc.failure_cases is a DataFrame: column, check, failure_case, index.
        print(exc.failure_cases.to_string(index=False))
        raise
```

### 2. Assert-based checks for a fail-fast pipeline gate

```python
"""Lightweight, dependency-free data quality gate using assertions and thresholds."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pandas as pd


class DataQualityError(AssertionError):
    """Raised when a blocking data quality expectation is violated."""


def assert_quality(
    df: pd.DataFrame,
    parent_customer_ids: set[str],
    *,
    max_null_rate: float = 0.01,
    freshness_sla: timedelta = timedelta(hours=24),
) -> None:
    """Fail fast on contract violations before the batch is written downstream."""
    n = len(df)
    if n == 0:
        raise DataQualityError("empty batch: refusing to publish zero rows")

    # Completeness: bounded null rate (threshold, not zero-tolerance).
    null_rate = df["phone"].isna().mean()
    if null_rate > max_null_rate:
        raise DataQualityError(f"phone null rate {null_rate:.3%} > {max_null_rate:.3%}")

    # Mandatory columns: strictly non-null.
    for col in ("transaction_id", "customer_id", "amount"):
        nulls = int(df[col].isna().sum())
        if nulls:
            raise DataQualityError(f"{col} has {nulls} nulls; expected 0")

    # Uniqueness / primary key.
    dupes = int(df["transaction_id"].duplicated().sum())
    if dupes:
        raise DataQualityError(f"transaction_id has {dupes} duplicate values")

    # Validity / range.
    if not df["amount"].between(0.0, 1_000_000.0).all():
        bad = int((~df["amount"].between(0.0, 1_000_000.0)).sum())
        raise DataQualityError(f"amount out of [0, 1e6] for {bad} rows")

    # Referential integrity: every FK resolves to the parent key set.
    orphans = set(df["customer_id"]) - parent_customer_ids
    if orphans:
        raise DataQualityError(f"{len(orphans)} customer_id values have no parent")

    # Freshness / timeliness.
    latest = pd.to_datetime(df["event_ts"]).max().to_pydatetime()
    if latest.tzinfo is None:
        latest = latest.replace(tzinfo=timezone.utc)
    age = datetime.now(timezone.utc) - latest
    if age > freshness_sla:
        raise DataQualityError(f"stale data: newest event is {age} old (SLA {freshness_sla})")
```

## Common errors

- **Checking after the damage is done.** Validating *after* the write (or only in a nightly
  report) means corrupt rows already reached consumers. Gate at the boundary and fail the
  job before publishing.
- **Boolean checks with no thresholds.** Zero-tolerance rules (`null_rate == 0`) on noisy
  columns cause constant false alarms; teams then disable the check entirely. Set explicit,
  agreed thresholds and separate blocking from warning expectations.
- **Ignoring nullability.** Leaving columns at the framework default (often nullable) lets
  missing required values slip through. Set `nullable=False` deliberately and distinguish
  "absent is invalid" from "absent is allowed".
- **Confusing uniqueness with non-null.** A unique constraint does not imply non-null (and
  vice versa). Assert both for primary keys.
- **Referential checks against a stale or partial parent set.** Loading only part of the
  parent keys produces phantom "orphan" failures. Compare against the authoritative,
  complete key set.
- **Naive timestamp comparisons.** Mixing tz-aware and tz-naive datetimes raises or, worse,
  compares incorrectly. Normalize to UTC before freshness math.
- **Silent failures.** Catching the validation error and continuing defeats the purpose.
  Log the failing cases, emit metrics, then re-raise on blocking violations.
