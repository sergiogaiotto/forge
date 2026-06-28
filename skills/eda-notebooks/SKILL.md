---
name: eda-notebooks
description: >-
  Structure clean, reproducible exploratory data analysis in notebooks: profiling,
  distributions, correlations, missingness and clear visualizations. Use whenever the user
  does EDA, explores a dataset, works in Jupyter/.ipynb notebooks, or asks to summarize data.
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

# EDA Notebooks

A repeatable, senior-level structure for exploratory data analysis in Jupyter
notebooks. The goal is a notebook that runs top to bottom, communicates findings
clearly, and never silently corrupts the raw data it loaded.

## When to use

Use this skill whenever you are:

- Starting EDA on a new or unfamiliar dataset.
- Working inside a Jupyter / `.ipynb` notebook (or a `# %%`-delimited script).
- Profiling a dataframe: shapes, dtypes, missingness, distributions.
- Investigating correlations or the relationship between features and a target.
- Asked to "summarize", "explore", "get a feel for", or "sanity-check" data.

Do **not** use this skill for production feature engineering, model training,
or building dashboards. Keep EDA exploratory and disposable; promote anything
worth keeping into versioned modules afterwards.

## Steps

Follow this order. Each step is its own cell (or `# %%` block) so the notebook
stays linear and re-runnable.

1. **Set up and seed.** Import libraries, set a random seed, configure display
   options and plot defaults. Determinism first: an EDA notebook that samples or
   shuffles without a seed is not reproducible.
2. **Load (read-only).** Read the source into a `raw` dataframe. Treat `raw` as
   immutable — never mutate it in place. Derive a working copy `df = raw.copy()`
   for any cleaning or transformation.
3. **Shape and dtypes.** Inspect `df.shape`, `df.dtypes`, `df.head()`, and
   `df.info()`. Confirm row/column counts match expectations and that numeric
   columns did not load as `object`.
4. **Missingness.** Quantify nulls per column (count and percentage) and
   visualize the pattern (missingno-style matrix/bar). Decide whether missingness
   is random or structural before doing anything else.
5. **Univariate distributions.** Profile each variable: `df.describe(include="all")`
   for the overview, histograms/KDE for numerics, `value_counts()` for categoricals.
   Always label axes and titles.
6. **Bivariate / correlations.** Compute a numeric correlation matrix and render
   it as an annotated heatmap. Add scatter plots or grouped boxplots for the
   relationships that matter.
7. **Target relationship.** If a target/label exists, study how features relate to
   it (grouped stats, class-conditional distributions) — **without** using the
   target to transform features (no leakage).
8. **Notes.** Close with a markdown cell capturing findings, data-quality issues,
   open questions, and next steps. The notes are the deliverable; the plots are
   evidence.

## Examples

### 1. Setup + profiling cell block

```python
# %% Setup
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
import seaborn as sns

RANDOM_SEED = 42
np.random.seed(RANDOM_SEED)

pd.set_option("display.max_columns", 100)
pd.set_option("display.width", 200)
sns.set_theme(style="whitegrid")

# %% Load (read-only) — never mutate `raw`
raw = pd.read_csv("data/dataset.csv")
df = raw.copy()

# %% Shape, dtypes, preview
print(f"rows={df.shape[0]:,}  cols={df.shape[1]:,}")
print(df.dtypes)
df.head()

# %% Profiling — full summary including categoricals
summary = df.describe(include="all").T
summary["n_missing"] = df.isna().sum()
summary["pct_missing"] = (df.isna().mean() * 100).round(2)
summary["n_unique"] = df.nunique()
summary

# %% Missingness overview (missingno-style, no extra deps)
missing = (
    df.isna()
    .mean()
    .mul(100)
    .sort_values(ascending=False)
    .loc[lambda s: s > 0]
)

fig, ax = plt.subplots(figsize=(8, max(2, 0.4 * len(missing))))
missing.plot.barh(ax=ax, color="#c0392b")
ax.set_xlabel("Missing (%)")
ax.set_ylabel("Column")
ax.set_title("Missingness by column")
ax.invert_yaxis()
fig.tight_layout()
plt.show()

# %% Univariate — categorical frequencies
for col in df.select_dtypes(include=["object", "category"]).columns:
    print(f"\n{col!r} — top 10 values")
    print(df[col].value_counts(dropna=False).head(10))
```

### 2. Correlation heatmap cell

```python
# %% Correlation heatmap (numeric features only)
numeric = df.select_dtypes(include="number")
corr = numeric.corr(method="pearson")

# Mask the upper triangle so each pair is shown once.
mask = np.triu(np.ones_like(corr, dtype=bool))

fig, ax = plt.subplots(figsize=(10, 8))
sns.heatmap(
    corr,
    mask=mask,
    cmap="coolwarm",
    vmin=-1.0,
    vmax=1.0,
    center=0.0,
    annot=True,
    fmt=".2f",
    linewidths=0.5,
    square=True,
    cbar_kws={"shrink": 0.8, "label": "Pearson r"},
    ax=ax,
)
ax.set_title("Feature correlation matrix")
fig.tight_layout()
plt.show()
```

## Common errors

- **No seed.** Sampling, shuffling, or train/test splits without
  `np.random.seed(...)` (and library-specific seeds) make the notebook
  non-reproducible — results drift on every re-run.
- **Giant, unlabeled plots.** Figures with no title, no axis labels, no units,
  or too many subplots crammed together communicate nothing. Every plot needs a
  title and labeled axes; set an explicit `figsize`.
- **Leaking the target.** Using the target to impute, scale, encode, or select
  features during EDA bakes label information into the "features" and inflates
  any later model. Inspect feature–target relationships; never transform features
  with the target.
- **Mutating the raw dataframe.** Editing `raw` in place (or forgetting
  `.copy()`, which yields a view) means re-running a cell silently changes
  upstream state. Keep `raw` immutable and work on `df = raw.copy()`.
- **Trusting dtypes blindly.** Numerics loaded as `object`, dates left as
  strings, or high-cardinality IDs treated as categoricals quietly break
  `describe`, correlations, and plots. Verify `df.dtypes` early.
- **`corr()` on the whole frame.** Calling `.corr()` before selecting
  `select_dtypes(include="number")` either errors or silently drops columns;
  be explicit about which columns enter the correlation matrix.
```
