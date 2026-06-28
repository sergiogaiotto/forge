# FORGE Gateway (referência)

Serviço server-side que concentra o que **não pode** viver no cliente (SPEC §5.1.7, ADR-3/ADR-6):

1. **Validação autoritativa de licença** + token de sessão + revogação (RF-013/015/017).
2. **Proxy de inferência** ao provedor in-network (HubGPU), medindo TTFT/latência/uso.
3. **Emissão de traces ao Langfuse** com mascaramento e amostragem — a `secretKey` do Langfuse fica
   **apenas aqui** (RNF-010), nunca no cliente nem no tráfego cliente↔gateway.

Implementado sem dependências (Node `http` + `fetch` global). Requer Node ≥ 18.

## Subir

```bash
cp gateway/.env.example gateway/.env   # ajuste UPSTREAM_BASEURL e, opcionalmente, Langfuse
node gateway/server.mjs
# FORGE gateway ouvindo em http://localhost:8787
```

No VSCode, configure a extensão:

```jsonc
// settings.json
"forge.license.mode": "gateway",
"forge.gateway.url": "http://localhost:8787",
"forge.egress.allowedHosts": ["localhost", "hub-gpus.claro.com.br"]
```

## Endpoints

| Método | Rota | Função |
|---|---|---|
| `GET`  | `/health` | status + se Langfuse está ligado |
| `POST` | `/license/activate` | `{key}` → verifica Ed25519 + revogação → `{token, expiresAt, subject, org}` |
| `POST` | `/license/renew` | `{token}` → renova a sessão |
| `POST` | `/v1/chat/completions` | proxy autenticado por `Authorization: Bearer <token>`; emite o trace |

O cliente propaga apenas metadados via headers `x-forge-session`, `x-forge-org`, `x-forge-model`,
`x-forge-skills`, `x-forge-provider` — **nunca** segredos. O gateway monta o `trace` + `generation`
e aplica `LANGFUSE_CAPTURE` (`full`/`masked`/`metadata-only`) e `LANGFUSE_SAMPLE_RATE`.

## Endurecimento (hardening)

- **Validação de config no boot** — encerra se faltar o `keyinfo` (chave pública); avisa sobre
  Langfuse/TLS mal configurados.
- **Sessões** com TTL (`SESSION_TTL_SEC`), varredura periódica de expiradas e teto (`MAX_SESSIONS`).
- **Rate limiting** por token (token bucket, `RATE_LIMIT_PER_MIN`) → HTTP 429.
- **Traces em lote** com buffer limitado (`LANGFUSE_QUEUE_MAX`), flush a cada `LANGFUSE_FLUSH_MS`,
  descarte controlado em overflow e **fail-open** (RNF-013) — nunca bloqueia a geração.
- **Observabilidade do próprio gateway**: logging estruturado (JSON) com `reqId`; `/health` expõe
  versão, uptime, nº de sessões, profundidade da fila e traces descartados.
- **Shutdown gracioso** (SIGINT/SIGTERM): para de aceitar, drena a fila de traces e encerra.
- **TLS opcional**: defina `HTTPS_KEY` e `HTTPS_CERT` para servir em HTTPS.
- **Timeout de upstream** (`UPSTREAM_TIMEOUT_MS`) → HTTP 502 em indisponibilidade.

> Referência funcional pronta para PoC e testes de integração. Para produção em escala, coloque atrás
> de mTLS in-network, persista sessões/revogações num store compartilhado (ex.: Redis) e migre o
> export para `@langfuse/otel` em lote, conforme a spec (T-044…T-049).
