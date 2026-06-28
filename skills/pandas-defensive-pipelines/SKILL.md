---
name: pandas-defensive-pipelines
description: >-
  Build and review pandas cleaning/transform pipelines with defensive handling of
  nulls, dtypes, duplicates and memory. Use whenever the user works with pandas
  DataFrames, CSV/parquet ingestion, feature cleaning, or data validation in Python.
license: Apache-2.0
metadata:
  author: claro-data-platform
  version: "1.0"
validators:
  - id: ruff
    label: ruff
    command: "ruff check {file}"
    gate: true
    appliesTo: [".py", ".ipynb"]
  - id: mypy
    label: mypy
    command: "mypy --ignore-missing-imports {file}"
    gate: true
    appliesTo: [".py"]
---

# Pandas Defensive Pipelines

A defensive pandas pipeline treats every incoming DataFrame as untrusted: dtypes
may silently fall back to `object`, nulls may hide in multiple representations
(`NaN`, `None`, `NaT`, empty string), duplicates may inflate aggregates, and
in-place mutation may corrupt a caller's data. This skill encodes a senior-level
playbook for writing cleaning/transform functions that fail loudly, stay
reproducible, and keep memory bounded.

## When to use

Use this skill when you are:

- Ingesting CSV, parquet, JSON, or Excel into pandas and the schema is not
  guaranteed (third-party feeds, user uploads, scraped data).
- Writing a reusable cleaning/feature-engineering function that other code calls.
- Reviewing a pipeline that mutates inputs, produces `SettingWithCopyWarning`,
  or has columns silently typed as `object`.
- Validating that a DataFrame matches an expected contract before it flows
  downstream (model training, a database load, an API response).
- Reducing memory footprint of a wide or long DataFrame.

Do **not** reach for this skill for trivial one-off exploration in a notebook
where correctness is not load-bearing; the overhead is not justified.

## Steps

A robust cleaning function should follow this order. Each step is defensive and
independent, so failures surface close to their cause.

1. **Copy at the boundary.** The first statement of any cleaning function is
   `df = df.copy()`. Never mutate the caller's object. This eliminates an entire
   class of aliasing bugs and most `SettingWithCopyWarning` noise.
2. **Validate the input contract.** Assert that the columns you depend on exist
   *before* touching them: `missing = required - set(df.columns)`. Fail with a
   clear message naming the missing columns rather than a downstream `KeyError`.
3. **Drop duplicates explicitly.** Always pass `subset=` (the business key) and
   `keep=` (`"first"`, `"last"`, or `False`). A bare `drop_duplicates()` compares
   *all* columns, which rarely matches intent and silently keeps near-dupes.
4. **Cast dtypes explicitly.** Do not rely on inference. Use `astype` with an
   explicit mapping; use `category` for low-cardinality strings and the nullable
   integer type (`"Int64"`) when a numeric column legitimately contains nulls.
5. **Parse datetimes with an errors policy.** Use `pd.to_datetime(..., errors=
   "raise")` when bad timestamps are a bug, or `errors="coerce"` when they are
   expected — but then **count the resulting `NaT`** and decide deliberately.
6. **Handle nulls with a documented strategy.** Choose per column: `dropna`
   (with `subset=`), `fillna` (with a sentinel/median/mode), or leave-and-flag.
   Write the rationale in a comment or docstring; never let it be implicit.
7. **Assert the output schema.** Re-check dtypes, row count invariants, and key
   uniqueness *after* cleaning. These asserts are cheap insurance and double as
   executable documentation of the function's postconditions.
8. **Downcast for memory.** As a final pass, downcast numerics with
   `pd.to_numeric(..., downcast=...)` and convert repeated strings to `category`.
   Do this last so it cannot interfere with intermediate computations.

## Examples

### Example 1 — A defensive cleaning function (before / after)

**Before** — mutates the input, infers everything, drops dupes on all columns,
and produces a chained-assignment warning:

```python
import pandas as pd


def clean(df):
    df.drop_duplicates(inplace=True)          # compares ALL columns
    df["amount"][df["amount"] < 0] = 0        # chained assignment -> SettingWithCopy
    df["signup"] = pd.to_datetime(df["signup"])  # raises opaquely on bad rows
    df = df.dropna()                          # drops rows for unrelated nulls
    return df
```

**After** — copies, validates, casts explicitly, documents null strategy, and
asserts postconditions:

```python
import pandas as pd


def clean_customers(df: pd.DataFrame) -> pd.DataFrame:
    """Clean the raw customer feed.

    Strategy:
      - Dedup on ``customer_id`` keeping the most recent row.
      - ``amount`` floored at 0; nulls treated as 0 (missing == no spend).
      - ``signup`` coerced; unparseable timestamps become NaT and are dropped.
    """
    df = df.copy()  # never mutate the caller's frame

    required = {"customer_id", "amount", "signup", "tier"}
    missing = required - set(df.columns)
    assert not missing, f"input missing required columns: {sorted(missing)}"

    df = df.sort_values("signup").drop_duplicates(
        subset=["customer_id"], keep="last"
    )

    df = df.astype(
        {
            "customer_id": "int64",
            "amount": "float64",
            "tier": "category",
        }
    )

    # null strategy: missing spend == 0, then floor negatives
    df["amount"] = df["amount"].fillna(0.0).clip(lower=0.0)

    df["signup"] = pd.to_datetime(df["signup"], errors="coerce")
    n_bad = int(df["signup"].isna().sum())
    if n_bad:
        # documented decision: unparseable signups are unusable -> drop
        df = df.dropna(subset=["signup"])

    # postconditions: schema is what downstream code relies on
    assert df["customer_id"].is_unique, "customer_id must be unique after dedup"
    assert df["amount"].ge(0).all(), "amount must be non-negative"
    assert df["signup"].notna().all(), "signup must be fully parsed"

    return df.reset_index(drop=True)
```

### Example 2 — Memory downcasting and the category dtype (before / after)

**Before** — a wide frame loaded with default dtypes; numerics are 64-bit and
repeated strings are `object`, costing far more memory than needed:

```python
import pandas as pd

df = pd.read_csv("events.csv")
# id: int64, count: int64, score: float64, country: object, status: object
print(df.memory_usage(deep=True).sum())
```

**After** — downcast numerics to the smallest safe width and convert
low-cardinality strings to `category`, validating the savings:

```python
import pandas as pd


def shrink(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()

    before = df.memory_usage(deep=True).sum()

    int_cols = df.select_dtypes(include="integer").columns
    for col in int_cols:
        df[col] = pd.to_numeric(df[col], downcast="integer")

    float_cols = df.select_dtypes(include="floating").columns
    for col in float_cols:
        df[col] = pd.to_numeric(df[col], downcast="float")

    # convert object columns to category only when cardinality is low
    obj_cols = df.select_dtypes(include="object").columns
    for col in obj_cols:
        if df[col].nunique(dropna=False) / max(len(df), 1) < 0.5:
            df[col] = df[col].astype("category")

    after = df.memory_usage(deep=True).sum()
    assert after <= before, "downcasting must not increase memory"
    return df
```

## Common errors

- **Silent `object` columns.** A column that should be numeric or datetime but
  prints as `object` almost always hides bad values (stray strings, mixed types).
  Always check `df.dtypes` after ingestion; cast explicitly instead of trusting
  inference. An `object` column also defeats vectorization and inflates memory.
- **Mutating the caller's input.** Functions that use `inplace=True` or assign to
  a passed-in `df` corrupt data the caller still holds. Start every cleaning
  function with `df = df.copy()` and return a new frame.
- **Confusing `NaN`, `None`, and `NaT`.** In float columns missing values are
  `NaN`; in `object` columns they may be `None`; in datetime columns they are
  `NaT`. They are *not* interchangeable in comparisons (`np.nan != np.nan`). Use
  `pd.isna()` rather than `== None` or `== np.nan`, and prefer nullable dtypes
  (`"Int64"`, `"boolean"`) when a column must carry both integers/bools and nulls.
- **Chained assignment (copy vs view).** `df[mask]["col"] = x` writes to a
  temporary and triggers `SettingWithCopyWarning` — the original is unchanged.
  Use a single `.loc`: `df.loc[mask, "col"] = x`. Likewise, a slice may be a view
  or a copy depending on memory layout; never depend on the distinction — copy
  explicitly when you intend an independent frame.
- **Bare `drop_duplicates()`.** Comparing all columns rarely matches the business
  key and silently keeps rows that differ only in a noise column. Always pass
  `subset=` and `keep=`.
- **`pd.to_datetime` / `pd.to_numeric` without an errors policy.** The default
  may raise mid-pipeline or, with `errors="coerce"`, silently produce `NaT`/`NaN`.
  Pick the policy deliberately and count the coerced rows.
