---
name: mlops-pipelines
description: >-
  Set up reproducible ML pipelines: experiment tracking (MLflow), model registry,
  packaging, and CI checks for ML. Use whenever the user works on MLOps, experiment
  tracking, model deployment, MLflow, or productionizing ML models.
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

# MLOps Pipelines

Build ML pipelines that are reproducible by construction: config-driven runs,
pinned environments, tracked experiments, a governed model registry, and CI
gates that fail fast before a bad model reaches production.

## When to use

Use this skill whenever the user is:

- Standing up or refactoring an ML training/inference pipeline and needs it to be
  **reproducible** (same config + same data + same env -> same model).
- Adding **experiment tracking** (parameters, metrics, artifacts) with MLflow, or
  migrating ad-hoc logging to `mlflow.autolog`.
- Promoting models through a **registry** with stages (None -> Staging -> Production)
  and needs aliases, versioning, or rollback.
- **Packaging** a model for serving (an MLflow `pyfunc` flavor, an `MLproject`
  entry point, or a container) and wants to avoid train/serve skew.
- Wiring **CI gates for ML**: lint, unit tests on data transforms, and model
  sanity checks (schema, metric thresholds, smoke inference).
- Reasoning about **data/model versioning** (dataset hashes, DVC/lakeFS, model
  lineage) so a run can be reconstructed later.

If the task is plain application code with no model lifecycle, this skill does not apply.

## Steps

1. **Pin the environment.** Declare exact versions in `requirements.txt`
   (`==`) or `conda.yaml`, plus the Python version. Never rely on whatever is
   installed globally. Capture the lockfile in source control next to the code.

2. **Make runs config-driven.** Put all hyperparameters, data paths, and split
   seeds in a single config (YAML/`pydantic`/`hydra`). No magic numbers in code —
   the config IS the experiment definition, and it gets logged with the run.

3. **Set the tracking backend.** Point `MLFLOW_TRACKING_URI` at a real server
   (or `file:./mlruns` locally). Name an experiment per project so runs are
   grouped; never let runs land in `Default`.

4. **Track everything that defines the result.** Log params, metrics, the config
   file, the model artifact, and an input/output signature + example. Prefer
   `mlflow.autolog()` for supported frameworks, and add manual logs for anything
   it misses (custom metrics, data version, git SHA).

5. **Version data and code.** Record the git commit, the dataset version/hash
   (or DVC/lakeFS pointer), and the row counts as tags. A run you cannot
   reconstruct is not a tracked run.

6. **Package the model.** Log it with a proper flavor (`mlflow.sklearn`,
   `mlflow.pyfunc`, etc.) including a `signature` and `input_example`. For custom
   pre/post-processing, wrap it in a `pyfunc` so the same transform code runs at
   train and serve time.

7. **Register and stage.** Register the artifact into the Model Registry, then
   promote via stages/aliases (`@champion`, `Production`) only after checks pass.
   Keep the previous version so rollback is one alias move.

8. **Gate in CI.** On every PR run: `ruff` (lint), `pytest` on transforms and
   metric code, and a model sanity check (schema matches signature, metric above
   threshold, smoke inference returns valid output). Fail the pipeline on any gate.

## Examples

### 1. MLflow-tracked training script (config-driven, reproducible)

```python
"""train.py — reproducible, fully tracked training run.

Run:
    MLFLOW_TRACKING_URI=http://localhost:5000 python train.py --config config.yaml
"""
from __future__ import annotations

import argparse
import subprocess
from pathlib import Path

import mlflow
import yaml
from mlflow.models.signature import infer_signature
from sklearn.datasets import load_breast_cancer
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import f1_score, roc_auc_score
from sklearn.model_selection import train_test_split


def git_sha() -> str:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "HEAD"], text=True
        ).strip()
    except Exception:
        return "unknown"


def main(config_path: str) -> None:
    cfg = yaml.safe_load(Path(config_path).read_text())

    X, y = load_breast_cancer(return_X_y=True, as_frame=True)
    X_train, X_test, y_train, y_test = train_test_split(
        X, y,
        test_size=cfg["data"]["test_size"],
        random_state=cfg["seed"],
        stratify=y,
    )

    mlflow.set_experiment(cfg["experiment_name"])
    with mlflow.start_run(run_name=cfg.get("run_name")):
        # Tag lineage so the run can be reconstructed later.
        mlflow.set_tags({
            "git_sha": git_sha(),
            "dataset": "sklearn.breast_cancer",
            "n_train_rows": len(X_train),
        })
        # The config IS the param set — log it as params AND as an artifact.
        mlflow.log_params(cfg["model"])
        mlflow.log_param("seed", cfg["seed"])
        mlflow.log_artifact(config_path, artifact_path="config")

        model = RandomForestClassifier(random_state=cfg["seed"], **cfg["model"])
        model.fit(X_train, y_train)

        proba = model.predict_proba(X_test)[:, 1]
        preds = (proba >= 0.5).astype(int)
        mlflow.log_metric("f1", f1_score(y_test, preds))
        mlflow.log_metric("roc_auc", roc_auc_score(y_test, proba))

        # Signature + example pin the serving contract and prevent train/serve skew.
        signature = infer_signature(X_test, model.predict(X_test))
        mlflow.sklearn.log_model(
            sk_model=model,
            artifact_path="model",
            signature=signature,
            input_example=X_test.iloc[:5],
            registered_model_name=cfg["registered_model_name"],
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    main(parser.parse_args().config)
```

Companion `config.yaml`:

```yaml
experiment_name: tumor-classifier
run_name: rf-baseline
registered_model_name: tumor-classifier
seed: 42
data:
  test_size: 0.2
model:
  n_estimators: 300
  max_depth: 8
  min_samples_leaf: 5
```

### 2. `pyfunc` wrapper (one transform path for train and serve)

Wrapping pre/post-processing in a `python_function` model guarantees the exact
same code runs in batch scoring, the REST server, and CI — eliminating train/serve skew.

```python
"""pyfunc_model.py — log a custom model whose preprocessing ships with it."""
from __future__ import annotations

import cloudpickle
import mlflow
import mlflow.pyfunc
import pandas as pd
from sklearn.base import BaseEstimator


class FraudScorer(mlflow.pyfunc.PythonModel):
    """Applies the SAME feature engineering used at training time, then scores."""

    def load_context(self, context) -> None:
        with open(context.artifacts["sklearn_model"], "rb") as f:
            self._model: BaseEstimator = cloudpickle.load(f)

    @staticmethod
    def _features(df: pd.DataFrame) -> pd.DataFrame:
        out = df.copy()
        out["amount_log"] = (out["amount"] + 1.0).clip(lower=0).pipe(__import__("numpy").log)
        out["is_intl"] = (out["country"] != "US").astype(int)
        return out[["amount_log", "is_intl", "merchant_risk"]]

    def predict(self, context, model_input: pd.DataFrame) -> pd.Series:
        features = self._features(model_input)
        scores = self._model.predict_proba(features)[:, 1]
        return pd.Series(scores, name="fraud_probability")


def log_pyfunc(trained_estimator: BaseEstimator, example: pd.DataFrame) -> None:
    """Persist the estimator and log the pyfunc that wraps it."""
    with open("sklearn_model.pkl", "wb") as f:
        cloudpickle.dump(trained_estimator, f)

    with mlflow.start_run():
        wrapper = FraudScorer()
        signature = mlflow.models.infer_signature(
            example, wrapper._features(example).assign(p=0.0)["p"]
        )
        mlflow.pyfunc.log_model(
            artifact_path="model",
            python_model=wrapper,
            artifacts={"sklearn_model": "sklearn_model.pkl"},
            signature=signature,
            input_example=example,
            # Pin the serving env so it matches training exactly.
            pip_requirements=[
                "mlflow==2.14.1",
                "scikit-learn==1.5.1",
                "pandas==2.2.2",
                "cloudpickle==3.0.0",
                "numpy==1.26.4",
            ],
            registered_model_name="fraud-scorer",
        )
```

Promote a registered version through the registry (only after CI gates pass):

```python
from mlflow.tracking import MlflowClient

client = MlflowClient()
# Modern alias-based promotion (preferred over legacy stage transitions).
client.set_registered_model_alias(
    name="fraud-scorer", alias="champion", version="7"
)
# Rollback is a single alias move back to the previous version.
```

## Common errors

- **Untracked params.** Hardcoding hyperparameters in code instead of logging
  them means a winning run cannot be reproduced. Drive everything from a config
  and `mlflow.log_params` (or `autolog`) it.
- **Non-pinned dependencies.** `scikit-learn` without `==` lets the serving image
  drift from the training image; a pickle then deserializes against an
  incompatible version and silently mis-predicts. Pin every dep and ship
  `pip_requirements`/`conda.yaml` with the model.
- **Train/serve skew.** Doing feature engineering in the notebook but a different
  (or absent) version in the API. Put the transform inside the `pyfunc` so one
  code path serves both, and test it in CI.
- **No model signature / input example.** Without a logged `signature`, serving
  accepts malformed payloads and fails at runtime. Always log a signature and an
  `input_example`.
- **Promoting without gates.** Moving a model to Production manually skips metric
  thresholds and schema checks. Gate promotion behind CI (lint, transform unit
  tests, sanity inference) and use aliases so rollback is instant.
- **Runs landing in `Default` / no experiment.** Forgetting `set_experiment`
  scatters runs and breaks comparison. Always name the experiment per project.
- **Logging the data, not its version.** Dumping the raw dataset as an artifact
  bloats storage and still loses lineage. Log a dataset hash / DVC pointer and
  the git SHA instead.
- **Mutable "latest" references.** Pointing serving at `latest` makes deployments
  non-deterministic. Pin to an explicit version or a controlled alias.
