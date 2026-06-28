# Changelog

All notable changes to FORGE are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/); versions follow SemVer.

## [1.0.2] — 2026-06-28

### Added
- **Identidade do dev na observabilidade (RF-063):** a extensão captura o **login
  do usuário** (do sistema operacional) e o propaga ao gateway nos headers de
  trace (`x-forge-login`, além de sessão, org, modelo e skills). O gateway grava o
  login como **`userId`** do trace no Langfuse (fallback para o hash do subject).
  Transparência ao dev: o indicador de telemetria mostra o login capturado.
  A captura efetiva ocorre quando a inferência passa pelo gateway.

## [1.0.1] — 2026-06-28

### Added
- Comando **FORGE: Abrir na direita (barra secundária)** e botão na barra de título do painel,
  para abrir/focar o FORGE na lateral direita do VSCode. Guia do Usuário documenta como mover o
  painel para a Barra Lateral Secundária (a posição é persistida pelo VSCode).
- Guias **docs/GUIA-DO-USUARIO.md** e **docs/GUIA-DO-ADMIN.md** (pt-BR, para leigos).

## [1.0.0] — 2026-06-27

Initial release. Implements the v1.0 scope of `SPEC-codegen-vscode.md`.

### Added
- **Multi-provider layer** (Strategy): OpenAI-compatible (HubGPU), OpenAI, and
  native Anthropic Messages, with uniform streaming, tool definitions, and a
  configurable timeout (default 300s). _RF-021/022/023/026/027/042_
- **HubGPU presets** for `gpt-oss-120b` and `gpt-oss-20b` with configurable
  auth header (`apiKey` default `not-needed`). _RF-022_
- **Skills system** (`SKILL.md`): discovery, frontmatter validation, 3-level
  progressive disclosure, per-workspace toggles, lexical retrieval above a
  configurable threshold, and `.claude/skills/` compatibility. _RF-030–038_
- **Local quality gates**: skills may attach validators (ruff/mypy/sqlfluff/…)
  run offline over the proposed diff; a gating validator blocks Apply on failure.
  _RF-039_
- **10 bundled data/ML skills**: pandas, polars, SQL (dialect-aware), dbt,
  Airflow, Spark, PyTorch, MLOps, data-quality, EDA. _RF-051_
- **License gating** (Ed25519): client-side signature/expiry/scope verification,
  authoritative server-side validation via the gateway with session tokens and
  periodic renewal; admin CLI to issue/revoke. _RF-010–017_
- **Secure storage**: license, session token, and provider/MCP credentials live
  only in VSCode SecretStorage, with weak-keyring detection. _RF-014/024, RNF-003_
- **Onboarding wizard** (license → provider) and **dev panel** (chat, streaming,
  reviewable diffs with one-click Apply, skill badges, validation gate, MCP and
  trace indicators) — React webview under a strict CSP. _RF-020/025, RNF-005_
- **Deny-by-default egress** enforcer over provider/gateway/Langfuse/MCP, with
  an admin allowlist; in-network operation. _RF-072/073, RNF-014/016_
- **Governed MCP** (in-network): admin catalog, allowlist, per-tool approval
  gate (least-privilege), credential references, and call auditing; streamable
  HTTP + stdio transports. _RF-070–077_
- **Reference gateway**: authoritative license validation, inference proxy, and
  Langfuse trace emission (masking, sampling) with the secret key server-side
  only. _RF-013/060–069, RNF-010–013_

- **RAG do codebase**: chunking semântico por fronteiras lógicas, embeddings
  in-network (OpenAI-compatible `/embeddings`) com degradação para BM25 lexical,
  reindexação incremental por watcher e comando dedicado. _RF-041, RF-079, RNF-009_
- **Gateway endurecido**: validação de config, sessões com TTL/teto, exportação
  de traces em lote com buffer limitado (fail-open), rate limiting, request-id,
  logging estruturado, shutdown gracioso e TLS opcional. _RNF-012/013_
- **CI/CD**: GitHub Actions (CI + release para Marketplace/Open VSX) e GitLab CI.

### Security
- Threat model documented: the client gate is a deterrent; the gateway is the
  authoritative control. Static checks confirm no secrets in settings/logs. _RNF-002_
