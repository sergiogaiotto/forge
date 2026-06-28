---
name: airflow-dags
description: >-
  Author and review Apache Airflow DAGs with idempotent tasks, correct scheduling,
  retries, sensors and the TaskFlow API. Use whenever the user writes or edits Airflow
  DAGs, operators, schedules, or orchestration code in Python.
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

# Airflow DAGs

Senior-level guidance for writing and reviewing Apache Airflow 2.x+ DAGs that are
idempotent, schedule correctly, recover from failure, and parse cheaply.

## When to use

Use this skill whenever you:

- Create a new DAG or refactor an existing one.
- Choose or fix a `schedule` / `start_date` / `catchup` configuration.
- Add `retries`, `retry_delay`, timeouts, or alerting to tasks.
- Decide between the TaskFlow API (`@dag` / `@task`) and classic operators.
- Wire dependencies, pass data via XCom, or build dataset-aware (data-driven) DAGs.
- Pick between a sensor and a deferrable operator for an external dependency.
- Review orchestration code for idempotency, backfill safety, or parse-time cost.

## Steps

1. **Pick the API.** Prefer the TaskFlow API (`@dag` + `@task`) for Python-native
   ETL: it removes boilerplate, handles XCom automatically, and reads top-to-bottom.
   Use classic operators when you need provider operators (e.g. `SQLExecuteQueryOperator`,
   `KubernetesPodOperator`) or fine-grained control over templating.
2. **Set a static `start_date`.** Use a fixed `pendulum.datetime(...)` or
   `datetime(..., tzinfo=...)` in the past. Never compute it from `datetime.now()` /
   `days_ago()` — a moving start date breaks scheduling and backfills.
3. **Choose the schedule.** Use a cron string (`"0 6 * * *"`), a preset
   (`"@daily"`), a `timedelta`, or a dataset/`Asset` list for data-driven runs.
   Set `schedule=None` for manually triggered DAGs.
4. **Decide `catchup` deliberately.** Default it to `catchup=False` unless you
   genuinely want every missed interval to backfill. Bound large backfills with
   `max_active_runs`.
5. **Make every task idempotent.** A task must produce the same result if re-run for
   the same logical date. Partition writes by `{{ ds }}` / `data_interval_start`,
   use `INSERT OVERWRITE` / `MERGE` / delete-then-insert, and avoid appending blindly.
6. **Configure resilience.** Set sensible `retries` and `retry_delay` (and
   `retry_exponential_backoff=True` for flaky upstreams) in `default_args`, plus
   `execution_timeout` to cap runaway tasks.
7. **Keep parse time cheap.** The scheduler imports every DAG file frequently. Put
   no heavy work at module top level — no DB connections, API calls, large file
   reads, or pandas loads outside a task function.
8. **Pass data the right way.** Use XCom only for small control-plane values (ids,
   counts, paths). Move real payloads through external storage (S3/GCS, a warehouse,
   a database) and pass references via XCom.
9. **Pick sensor vs deferrable.** Replace classic poking sensors with deferrable
   operators (or `mode="reschedule"` sensors) so you don't pin a worker slot while
   waiting on an external event.
10. **Run validators.** Lint with `ruff check {file}` and confirm the DAG imports
    cleanly (`python your_dag.py` or `airflow dags list-import-errors`) before merge.

## Examples

### 1. TaskFlow ETL DAG

A daily, idempotent extract/transform/load using the TaskFlow API. Note the static
`start_date`, `catchup=False`, retries with backoff, and date-partitioned writes.

```python
from __future__ import annotations

import pendulum

from airflow.decorators import dag, task

default_args = {
    "owner": "data-platform",
    "retries": 3,
    "retry_delay": pendulum.duration(minutes=5),
    "retry_exponential_backoff": True,
    "execution_timeout": pendulum.duration(hours=1),
}


@dag(
    dag_id="sales_daily_etl",
    schedule="0 6 * * *",  # 06:00 every day
    start_date=pendulum.datetime(2024, 1, 1, tz="UTC"),
    catchup=False,
    max_active_runs=1,
    default_args=default_args,
    tags=["sales", "etl"],
)
def sales_daily_etl():
    @task
    def extract(data_interval_start=None) -> str:
        # Heavy imports stay inside the task, not at module top level.
        import requests

        ds = data_interval_start.to_date_string()
        resp = requests.get(
            "https://api.example.com/sales", params={"date": ds}, timeout=30
        )
        resp.raise_for_status()
        # Persist the payload to durable storage; return only a reference.
        path = f"s3://raw-bucket/sales/{ds}/sales.json"
        # ... upload resp.content to `path` ...
        return path

    @task
    def transform(raw_path: str) -> str:
        import pandas as pd

        df = pd.read_json(raw_path)
        df = df[df["amount"] > 0]
        out_path = raw_path.replace("raw-bucket", "staging-bucket")
        df.to_parquet(out_path, index=False)
        return out_path

    @task
    def load(staged_path: str, data_interval_start=None) -> None:
        ds = data_interval_start.to_date_string()
        # Idempotent: overwrite the partition for this logical date instead of
        # appending, so re-runs converge to the same state.
        sql = f"""
            DELETE FROM analytics.sales WHERE sale_date = '{ds}';
            COPY INTO analytics.sales FROM '{staged_path}';
        """
        # ... execute `sql` against the warehouse ...

    load(transform(extract()))


sales_daily_etl()
```

### 2. Sensor-gated pipeline (deferrable, then process)

Wait for an upstream file to land before processing. Uses a deferrable sensor so it
does not hold a worker slot while waiting, and a `reschedule`-mode fallback pattern.

```python
from __future__ import annotations

import pendulum

from airflow.decorators import dag, task
from airflow.providers.amazon.aws.sensors.s3 import S3KeySensor

default_args = {
    "owner": "data-platform",
    "retries": 2,
    "retry_delay": pendulum.duration(minutes=10),
}


@dag(
    dag_id="ingest_when_file_arrives",
    schedule="@daily",
    start_date=pendulum.datetime(2024, 1, 1, tz="UTC"),
    catchup=False,
    default_args=default_args,
    tags=["ingest", "sensor"],
)
def ingest_when_file_arrives():
    # Deferrable=True frees the worker slot while the trigger waits on the event.
    wait_for_file = S3KeySensor(
        task_id="wait_for_file",
        bucket_name="landing-bucket",
        bucket_key="incoming/{{ ds }}/data.csv",
        deferrable=True,
        timeout=60 * 60 * 6,  # give up after 6h instead of waiting forever
        poke_interval=60,
    )

    @task
    def process(ds: str | None = None) -> int:
        import pandas as pd

        df = pd.read_csv(f"s3://landing-bucket/incoming/{ds}/data.csv")
        # Idempotent write keyed by the logical date partition.
        df.to_parquet(f"s3://curated-bucket/data/{ds}/data.parquet", index=False)
        return len(df)

    wait_for_file >> process()


ingest_when_file_arrives()
```

## Common errors

- **`start_date=datetime.now()` (or `days_ago()`):** a moving start date makes the
  scheduler unable to compute stable intervals; runs are skipped or never trigger.
  Use a fixed timezone-aware `pendulum.datetime(...)`.
- **Non-idempotent tasks:** blind `INSERT` / file append means a retry or backfill
  duplicates data. Always overwrite/merge the partition for the logical date.
- **Heavy code at parse time:** DB connections, API calls, large reads, or pandas
  loads at module top level run on every scheduler parse and slow the whole cluster.
  Keep them inside task bodies.
- **`catchup=True` by accident:** deploying a DAG with an old `start_date` and
  default catchup can launch hundreds of backfill runs at once. Set `catchup=False`
  and bound concurrency with `max_active_runs`.
- **Large payloads through XCom:** XCom is backed by the metadata DB and meant for
  small values. Push big data to object storage / a warehouse and pass references.
- **Poking sensors that pin workers:** a default-mode sensor occupies a worker slot
  for its whole wait. Use `deferrable=True` or `mode="reschedule"`, and always set a
  `timeout`.
- **No `retries` / `execution_timeout`:** transient failures become hard failures and
  hung tasks run forever. Set both in `default_args`.
- **Mutable default arguments or shared state across tasks:** tasks run in separate
  processes/workers; never rely on in-memory globals to pass state between them.
```
