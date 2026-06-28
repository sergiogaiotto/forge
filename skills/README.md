# FORGE Skills — catálogo do admin

Cada subdiretório é uma **Skill** no padrão aberto Agent Skills: um `SKILL.md` com frontmatter YAML
e corpo em markdown. O FORGE descobre, valida e injeta skills com *progressive disclosure*
(SPEC §3.4, RF-030–039).

## Catálogo empacotado (RF-051)

| Skill | Domínio | Validadores |
|---|---|---|
| `pandas-defensive-pipelines` | pandas: limpeza defensiva (nulos, dtypes, duplicados) | ruff + mypy (gate) |
| `polars-pipelines` | Polars lazy/expressões | ruff (gate) |
| `sql-dialect-aware` | SQL por dialeto, window functions | sqlfluff |
| `dbt-modeling` | dbt: camadas, testes, incremental | — |
| `airflow-dags` | Airflow: TaskFlow, idempotência | ruff |
| `spark-pipelines` | PySpark: partição, joins, skew | ruff |
| `pytorch-training` | PyTorch: training loop, AMP, checkpoint | ruff |
| `mlops-pipelines` | MLflow, registry, CI de ML | ruff (gate) |
| `data-quality-checks` | Pandera/GE: completude, ranges, PK | ruff (gate) |
| `eda-notebooks` | EDA reprodutível em notebooks | ruff |

## Frontmatter

```yaml
---
name: pandas-defensive-pipelines     # [a-z0-9-], 1–64, == nome do diretório
description: >-                       # 1–1024; o que faz E quando usar (trigger)
  Build pandas pipelines... Use whenever the user works with DataFrames.
license: Apache-2.0                   # opcional
metadata: { author: claro-data-platform, version: "1.0" }   # opcional
validators:                           # opcional (RF-039 — quality gate local)
  - id: ruff
    label: ruff
    command: "ruff check {file}"      # {file} = arquivo candidato (temp)
    gate: true                        # falha bloqueia o "Aplicar" do diff
    appliesTo: [".py", ".ipynb"]      # extensões alvo (opcional)
---
# Corpo: quando usar, passo a passo, exemplos exatos, erros comuns
```

Estrutura opcional por skill: `scripts/` (executáveis), `references/` (sob demanda), `assets/`.

## Progressive disclosure

1. **Discovery** — só `name` + `description` entram no system prompt (~100 tokens/skill).
2. **Activation** — quando a query casa, o **corpo** do `SKILL.md` é carregado.
3. **Execution** — `references/`/`scripts/`/`assets/` são lidos só quando referenciados.

Acima de `forge.skills.retrievalThreshold` skills habilitadas, o discovery seleciona top-K por
relevância lexical (RF-037/079) — funciona offline, sem embeddings externos.

## Onde o FORGE procura skills

1. `forge.skills.managedDir` (admin) **ou** este diretório empacotado;
2. `~/.forge/skills/` (global do usuário);
3. `<workspace>/.forge/skills/` e `<workspace>/.claude/skills/` (compat — RF-038).

Precedência: workspace > usuário > admin. Toggle por workspace via UI (RF-036).
