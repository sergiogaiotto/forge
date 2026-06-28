<div align="center">

# 🔥 FORGE — ADEX-Codegen

**Geração de código assistida por IA para times de dados e IA, dentro do VSCode.**

Multi-provedor (HubGPU · OpenAI · Anthropic) · Skills governadas · Licença Ed25519 ·
Quality gates locais · MCP in-network · Observabilidade no gateway · Operação offline-da-internet.

</div>

---

FORGE é uma extensão de VSCode que entrega codegen para cientistas/engenheiros de dados e de IA.
Implementa o escopo v1.0 da spec [`SPEC-codegen-vscode.md`](SPEC-codegen-vscode.md): provedores
plugáveis, um sistema de **Skills** (`SKILL.md`) com progressive disclosure, **license gating**
Ed25519 com validação autoritativa server-side, **MCP governado** restrito à rede interna e
**observabilidade** via Langfuse emitida no gateway.

> **Nota de engenharia.** Esta é uma implementação independente, limpa, cuja arquitetura segue a
> spec e se inspira no Cline (Apache-2.0) e no padrão aberto Agent Skills — sem usar a marca/código
> "Cline" (ver [NOTICE](NOTICE)). Foi construída para **compilar, empacotar e rodar** de ponta a ponta.

## ✨ Destaques

| Capacidade | O que faz | Requisitos |
|---|---|---|
| **Provedores multi-LLM** | OpenAI-compatible (HubGPU), OpenAI e Anthropic nativo, streaming uniforme, timeout 300s | RF-020–027, RF-042 |
| **Presets HubGPU** | `gpt-oss-120b` / `gpt-oss-20b` prontos, header de auth configurável | RF-022 |
| **Skills** | descoberta, validação de frontmatter, disclosure em 3 níveis, toggle, retrieval lexical | RF-030–038 |
| **RAG do codebase** | chunking semântico, embeddings in-network com degradação para BM25 lexical, reindex incremental | RF-041, RF-079, RNF-009 |
| **Quality gates locais** | skill pode anexar `ruff`/`mypy`/`sqlfluff`/scripts; gate reprova bloqueia o *Aplicar* | RF-039 |
| **10 skills de dados** | pandas, polars, SQL, dbt, Airflow, Spark, PyTorch, MLOps, data-quality, EDA | RF-051 |
| **Licença Ed25519** | verificação local + validação autoritativa no gateway + sessão renovável + revogação | RF-010–017 |
| **Segredos** | tudo em SecretStorage; nada em `settings.json`/logs | RF-014/024, RNF-001/003 |
| **Egress deny-by-default** | allowlist in-network; destinos externos bloqueados e logados | RF-072/073, RNF-014/016 |
| **MCP governado** | catálogo do admin, aprovação por ferramenta, auditoria, in-network | RF-070–077 |
| **Observabilidade** | trace + `generation` no gateway; `secretKey` só no servidor; fail-open | RF-060–069, RNF-010–013 |

## 🚀 Começando (do zero ao funcionando)

Pré-requisitos: **Node ≥ 18** (testado em 22), VSCode ≥ 1.90.

```bash
npm install          # instala dependências
npm run keygen       # gera o par Ed25519 do admin e embute a chave PÚBLICA no cliente
npm run build        # compila a webview (Vite) e a extensão (esbuild) → dist/
npm test             # roda a suíte de testes (29 testes)
```

Emita uma licença de teste (já feito por `keygen` em `admin-cli/keys/SAMPLE_LICENSE.txt`):

```bash
npm run license:issue -- --subject sergio.gaiotto@claro.com.br --org claro --scope codegen,skills --days 365
```

### Rodar a extensão

1. Abra esta pasta no VSCode.
2. Pressione **F5** (Run Extension) — abre uma janela *Extension Development Host*.
3. Clique no ícone 🔥 **FORGE** na activity bar.
4. **Onboarding:** cole a licença de `admin-cli/keys/SAMPLE_LICENSE.txt` → escolha o provedor
   (HubGPU pré-selecionado) → **Concluir**.
5. **Dev panel:** abra um arquivo, descreva a tarefa (ex.: *"Limpe o churn.parquet: remova
   duplicados, ajuste tipos e trate nulos com segurança"*). O FORGE ativa a skill
   `pandas-defensive-pipelines`, transmite a resposta, propõe um **diff**, roda **ruff + mypy**
   localmente e só libera **Aplicar** se o gate passar.

> Há um `.vscode/launch.json` pronto para F5. Para empacotar um `.vsix`: `npm run package`.

### Modo local vs. gateway

- **`forge.license.mode = local`** (default): valida a licença só no cliente (Ed25519). Ótimo para
  PoC/desenvolvimento. Tudo funciona offline.
- **`forge.license.mode = gateway`** + **`forge.gateway.url`**: validação autoritativa server-side,
  proxy de inferência e emissão de traces. Suba o gateway de referência (ver [`gateway/`](gateway/README.md)).

## 🧩 Arquitetura

```
Extension Host (TS/Node, esbuild)                    Webview (React, Vite)
├─ extension.ts ........... ativação, comandos         ├─ Onboarding (licença → provedor)
├─ core/Controller ....... estado único, orquestração  ├─ DevPanel (chat, diff, gate, MCP)
├─ core/Task ............. geração, parse de diffs      └─ protocolo tipado via postMessage
├─ api/providers ......... OpenAI-compat / OpenAI / Anthropic
├─ skills/ ............... loader, selector, assembler, validator (gate)
├─ rag/ .................. chunker, BM25, embeddings, CodebaseIndex (incremental)
├─ license/ .............. verifier Ed25519, client (gateway/local)
├─ mcp/ .................. registry, approval gate, auditor, client
├─ net/EgressEnforcer .... deny-by-default
└─ secrets/SecretsStore .. wrapper sobre context.secrets

admin-cli/forge-admin.mjs ... keygen · issue · revoke (chave PRIVADA fica aqui)
gateway/server.mjs .......... licença autoritativa · proxy · Langfuse (secretKey server-side)
skills/ ..................... catálogo empacotado (10 skills de dados/IA)
```

Decisões de design completas (ADR-1…8) estão na spec, §5.2.

## ⚙️ Configuração (managed settings do admin)

| Setting | Default | Descrição |
|---|---|---|
| `forge.gateway.url` | `""` | Gateway in-network (vazio = modo local) |
| `forge.license.mode` | `local` | `gateway` (autoritativo) ou `local` |
| `forge.skills.managedDir` | `""` | Diretório do catálogo de skills do admin (vazio = empacotado) |
| `forge.skills.retrievalThreshold` | `15` | Acima disso, discovery vira top-K por relevância |
| `forge.skills.topK` | `8` | K do retrieval |
| `forge.egress.allowExternal` | `false` | **Deny-by-default.** Não altere sem segurança |
| `forge.egress.allowedHosts` | `[hub-gpus.claro.com.br]` | Hosts in-network permitidos |
| `forge.mcp.catalog` | `[]` | Catálogo de MCP servers (schema `McpServerEntry`) |
| `forge.validation.gateBlocksApply` | `true` | Gate reprovado bloqueia *Aplicar* |
| `forge.telemetry.enabled` | `false` | Telemetria de produto opt-in |

## 🔎 RAG do codebase (RF-041 / RF-079)

O FORGE indexa o workspace e injeta os trechos mais relevantes na geração:

- **Chunking** por fronteiras lógicas (def/class/células `# %%`/headings/SQL) com metadados
  (arquivo, linhas, símbolo, linguagem); notebooks têm o código das células extraído.
- **Embeddings in-network** (default: **Qwen3-Embedding-0.6B** via hub interno) por busca de
  cosseno. O `baseUrl` é só a base (ex.: `…/embed06b/v1`); **o `/embeddings` é adicionado pelo
  client**. Sem endpoint, **degrada para BM25 lexical** (RF-079), 100% offline.
- **Densidade do vetor** configurável (MRL/Matryoshka): `0` = padrão do modelo (1024). Mudar exige
  reindex.
- **Reindex incremental** ao salvar/criar/excluir arquivos; comando **FORGE: Reindexar codebase (RAG)**
  força a reconstrução. Egress sempre sob a política deny-by-default.

```jsonc
// settings.json — embeddings in-network (Claro HubGPU / Qwen3)
"forge.rag.enabled": true,
"forge.rag.embeddings.url": "https://hub-gpus.claro.com.br/embed06b/v1", // sem /embeddings
"forge.rag.embeddings.model": "Qwen/Qwen3-Embedding-0.6B",
"forge.rag.embeddings.dimensions": 0,   // 0 = padrão do modelo (1024)
"forge.rag.maxChunks": 8
```

## 🤖 CI/CD

- **GitHub Actions** — [`ci.yml`](.github/workflows/ci.yml) roda typecheck + testes + build + empacota
  o `.vsix` em cada push/PR; [`release.yml`](.github/workflows/release.yml) publica no **VS Marketplace**
  e **Open VSX** ao criar uma tag `v*`.
- **FORGE Review na PR** — [`forge-review.yml`](.github/workflows/forge-review.yml) +
  [`ci/forge-review.mjs`](ci/forge-review.mjs): revisão por IA da Pull Request **in-network** (HubGPU),
  com comentários inline — o "CodeRabbit soberano" (código não sai da empresa). No-op se não configurado.
- **GitLab CI** — [`.gitlab-ci.yml`](.gitlab-ci.yml) com estágios `verify → review → build → publish`
  (revisão de MR + publish manual em tags).

Secrets necessários: `VSCE_PAT` (Azure DevOps → VS Marketplace) e `OVSX_PAT` (Open VSX). A chave
**pública** Ed25519 fica versionada em `src/license/embeddedKey.ts`; a privada nunca entra no repo.

## 🛡️ Modelo de segurança (resumo, RNF-002)

- O gate **client-side é um dissuasor**; o controle efetivo é o **gateway** (recusa inferência sem
  licença válida). Um cliente adulterado não obtém inferência.
- A **chave privada** Ed25519 nunca sai do admin; só a pública é embutida. A **`secretKey`** do
  Langfuse vive **apenas no gateway**. Credenciais de provedor/MCP só em SecretStorage.
- **Egress deny-by-default**: nenhuma chamada silenciosa à internet; fluxos centrais rodam in-network.

## 🧪 Testes & qualidade

```bash
npm run typecheck   # tsc da extensão e da webview
npm test            # 29 testes: licença Ed25519, frontmatter, selector, assembler, egress, diffs, catálogo
npm run build       # build de produção
```

Cobertura por nível e matriz de rastreabilidade RF/RNF → tarefa → teste estão na spec (§10–11).

## 📦 Estrutura do repositório

```
forge/
├─ src/                 código da extensão (host)
├─ webview-ui/          React (Vite)
├─ skills/              catálogo empacotado (10 SKILL.md)
├─ admin-cli/           CLI de licenças (Ed25519)
├─ gateway/             gateway de referência (licença + proxy + Langfuse)
├─ media/               ícones (flame.svg, forge-icon.png)
├─ dist/                saída de build (gerada)
└─ SPEC-codegen-vscode.md   fonte única da verdade
```

## 📚 Mais

- **Guia do Usuário** (passo a passo, para leigos): [`docs/GUIA-DO-USUARIO.md`](docs/GUIA-DO-USUARIO.md)
- **Guia do Admin** (licenças, gateway, skills, MCP): [`docs/GUIA-DO-ADMIN.md`](docs/GUIA-DO-ADMIN.md)
- Autoria de skills: [`skills/README.md`](skills/README.md)
- Gateway e Langfuse: [`gateway/README.md`](gateway/README.md)
- Admin (licenças): [`admin-cli/README.md`](admin-cli/README.md)

Licença do produto: **Apache-2.0** ([LICENSE](LICENSE) · [NOTICE](NOTICE)).
