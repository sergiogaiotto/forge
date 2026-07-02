# Changelog

All notable changes to FORGE are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/); versions follow SemVer.

## [2.0.1] — 2026-07-01

### Fixed
- **Blueprint/Charter truncados pelo raciocínio do `gpt-oss` em esforço alto.** No gpt-oss o raciocínio
  **compartilha o `max_tokens` com a resposta final**; em esforço alto ele consumia o orçamento inteiro e
  o plano saía truncado (`finish_reason=length`) → "resposta sem blueprint válido", e as seções do
  Charter eram salvas **cortadas no meio da palavra**. Agora as tarefas one-shot estruturais
  (Blueprint/Charter) rodam com esforço **"low"** (a geração de código mantém o esforço do usuário), e o
  `parseBlueprint` **repara um array truncado** (recupera os arquivos completos) — só com truncamento
  confirmado e preferindo o candidato mais tardio (um rascunho vazado do raciocínio não vira plano).
- **Preâmbulo do canal de análise vazado sem marcador** ("Now final output is markdown string." /
  "Proceed.") não polui mais o Charter salvo; conteúdo após o marcador do canal final nunca é tocado.
- **Avisos de truncamento agora aparecem DENTRO dos modais** (Blueprint: "plano parcial — revise antes
  de aprovar"; Charter: aviso ancorado na seção). Antes eram toasts que renderizavam **atrás** do modal
  e sumiam em 5s — invisíveis exatamente no cenário em que importavam.
- **Resposta vazia ao redigir uma seção do Charter não apaga mais o rascunho digitado** — vira um erro
  na própria seção (com proteção duplicada no reducer da webview).

## [2.0.0] — 2026-07-01

### Added — Modo Projeto (Blueprint aprovável), Charter e anexos
- **Roteamento de intenção no Modo Projeto.** Com "Projeto" ligado, uma **pergunta/diagnóstico** (colar
  logs + "o que aconteceu?") é respondida no **chat**, não sequestrada para o Blueprint. Ao aplicar
  todos os arquivos, o Modo Projeto **se desmarca sozinho** (fim de fluxo).
- **UX do modal Blueprint.** O planejamento **narra o que está acontecendo** (inclui um *heartbeat* com
  tempo decorrido durante o raciocínio do modelo, para não parecer travado); cada arquivo tem um
  **tooltip** com objetivo + dependências; e o status vai de **"gerando…" → "gerado" um a um**.
- **Falha do Blueprint agora é visível e acionável.** Em vez de o modal fechar com um toast efêmero, ele
  **fica aberto com o erro real + "Tentar de novo"** — tanto no planejamento quanto na geração.
- **Anexar seleção do terminal** ao chat (além do editor/arquivo/upload), para pedir ao FORGE que
  avalie um erro.
- **Colar um print no chat → OCR.** O texto do print é extraído (via o `tesseract` do **sistema** — não
  incha o `.vsix`) e anexado. Auto-detecta o `tesseract` (PATH + locais padrão/por-usuário) e aceita
  `forge.ocr.tesseractPath`/`forge.ocr.tessdataPath`; degrada com clareza quando não instalado.

### Fixed
- **`gpt-oss` (harmony) via HubGPU vazava o canal de raciocínio na saída final** — poluía o campo do
  Charter ("Now final output is markdown string. Proceed.") e **quebrava o JSON do Blueprint** (o modal
  fechava sem gerar nada). Agora o texto é saneado na camada de consumo (`stripHarmony`) e o
  `parseBlueprint` faz **extração balanceada** robusta (imune a prosa/marcadores, com teto anti-O(n²)).
- **"Aplicar tudo" não grava mais o último arquivo por engano.** O README (último na ordem de
  dependência) era carimbado como "parcial" por causa de um corte por `finish_reason=length` mesmo
  completo, e o "Aplicar tudo" o pulava. Agora só marca parcial o arquivo **de fato** truncado.
- **"Salvar" do Charter fecha o modal** e volta à tela principal.

## [1.8.0] — 2026-06-29

### Added — Execução ao vivo no terminal
- **"Executar" agora roda no terminal integrado** (área central), visível, com a saída transmitida
  **ao vivo**. Usa a *shell integration* do VSCode para capturar saída + exit code (mantém o loop de
  auto-cura "Corrigir com FORGE"); cai automaticamente para um **painel lateral com streaming** quando
  o shell não tem *shell integration*.
- **Botão trava durante a execução** ("Executando…", desabilitado) e vira **"Reexecutar"** ao concluir.
  Cartão ao vivo com **cronômetro**, auto-scroll, **Cancelar** e **Ver no terminal**.
- **Cancelamento e timeout matam a árvore de processos** (não deixam o processo-neto órfão no Windows).
- **Uma execução por vez** (o terminal é compartilhado) e o botão nunca fica preso: o resultado é
  sempre emitido, mesmo em erro/cancelamento.
- Nova ação **"Aplicar e executar"** (aplica o diff, abre o arquivo e executa em um clique).
- Requer **VSCode ≥ 1.93** (shell integration estável).

### Fixed
- **Cartão "Aplicar" de `forge-file` quando o modelo erra a cerca.** Um arquivo cujo bloco vinha com
  cerca de fechamento **descasada** (abre com 3 crases, fecha com 4) ou **ausente** (truncado) virava
  texto cru no chat, sem cartão para aplicar (visto com modelos menores ao gerar um `requirements.txt`).
  O parser final agora **recupera** esse bloco de forma conservadora (delimitado pela cerca solta ou
  pela abertura do próximo bloco), preservando a coerência entre o cartão e a remoção da cerca da prosa.
- **Sem proposta-amálgama.** Um bloco nunca atravessa a abertura do bloco seguinte (`forge-file` ou
  `forge-cell`): quando o modelo esquece o fechamento do 1º arquivo, os dois viram propostas separadas
  em vez de o 1º engolir o 2º.
- **Garantia das 4 crases preservada.** Um bloco bem-formado que documenta o protocolo no corpo
  (um `forge-file`/`forge-cell` interno de 3 crases) não é mais truncado. Abertura e fechamento exigem
  **coluna 0** (simétrico), evitando que um bloco indentado engula a própria cerca.
- Reforço no protocolo do system prompt: a cerca de fechamento é obrigatória e tem de casar a contagem
  de crases da abertura.

## [1.7.0] — 2026-06-28

### Added — Perfil de projeto (governança de contexto)
- **`.forge/project.md` versionado**, injetado em todo prompt: **stack auto-detectada**
  (linguagem, gerenciador, lint/tipos/testes, libs), **papel** do dev (ajusta estilo/defaults)
  e **regras** do time. Gesto **"promover correção a regra"** (1 clique). **Camada admin**
  (`forge.project.managedProfile`) — governança em 3 camadas admin → usuário → workspace.
- **Painel "Perfil"** no compositor: stack + papel + regras + editar.
- **Convenções-como-validators**: as ferramentas detectadas viram validadores do quality gate.

### Added — Observabilidade do cliente (Langfuse)
- Instrumenta a geração **e o workflow ao redor** (skill, aplicar/descartar, gate, execução,
  testes, revisão, perfil) — o que o gateway não vê. Sink **plugável** (direto agora;
  gateway-relay governado depois). Máscara de PII/segredos; `userId` hasheado; fail-open.
  Config `forge.observability.langfuse.*` + comando *Configurar observabilidade*.

### Added — UX de geração (magic buttons)
- **Cartão de proposta ao vivo** durante o stream (some a cerca crua do chat).
- **Aplicar e abrir** no editor, *Ver diff*, overflow ⋯ (Copiar/Descartar).

### Fixed
- Saída do runner em **UTF-8** (acentos no Windows) e proibição de **emojis** no código gerado.
- Blocos `forge-file`/`forge-cell` com **cerca de 4 crases** (suporta ``` aninhada em README/docstrings).

## [1.6.0] — 2026-06-28

### Added — Busca interna governada (substitui a "web")
- **Buscar (rede interna)** no menu de contexto: quando o admin define
  `forge.search.server` (um MCP do `forge.mcp.catalog`), o item antes bloqueado vira
  uma **busca real em fonte interna** (wiki/docs/Confluence) — via MCP, com
  **egress/aprovação/auditoria** já aplicados. Os resultados entram como anexo de
  contexto. **Nada de internet pública** — o equivalente soberano ao "Browse the web".
- Configurável: `forge.search.server`, `forge.search.tool` (default `search`),
  `forge.search.queryArg` (default `query`).

## [1.5.0] — 2026-06-28

### Added — Anexar contexto (menu "+")
- **Anexar contexto** no compositor (botão 📎): **seleção do editor**, **arquivo do
  workspace** (quick pick) e **enviar do computador** (upload de arquivo de texto).
  Os anexos viram chips removíveis e entram no contexto da próxima mensagem (in-network).
- **"Buscar na web" — bloqueada por política** (deny-by-default / soberania de dados),
  exibida no menu de forma transparente; busca, quando necessária, deve vir de fonte
  **interna** (MCP), não da internet pública.

## [1.4.0] — 2026-06-28

### Added — Notebooks (.ipynb) célula-a-célula
- **Edição por célula.** O FORGE edita notebooks por **célula** (não reescreve o
  arquivo): protocolo `forge-cell` com `op=add after=N` / `op=replace index=N`. As
  propostas são aplicadas no notebook **ao vivo** via `NotebookEdit`, preservando as
  demais células, saídas e metadados. Botões **Inserir célula** / **Substituir célula [N]**.
- **Execução por célula.** Botão **Executar célula** roda a célula aplicada (kernel do
  notebook), **captura a saída/erro** e, em falha, oferece **"Corrigir com FORGE"**.
- **Contexto de notebook.** Quando um `.ipynb` está aberto, o FORGE recebe as células
  com índice absoluto, para referenciá-las/editá-las com precisão.

## [1.3.0] — 2026-06-28

### Added — Fase D: painel "Definição de Pronto" (DoD)
- **Checklist de DoD** acima do compositor, consolidando o ciclo num só lugar:
  **Aplicado · Gate · Executa · Testes · Revisão**, cada um com estado
  (✓ ok · ✗ falhou · ○ pendente). Os pendentes acionáveis (Executa/Testes/Revisão)
  rodam com um clique. Quando tudo fica verde, o painel exibe **✅ Pronto**.
- Aplicar uma nova alteração reabre o item **Revisão** (a mudança precisa ser
  revisada de novo).

## CI — FORGE Review na PR — 2026-06-28 (Fase C; não altera o `.vsix`)

### Added
- **Revisão de Pull/Merge Request por IA, in-network** ("CodeRabbit soberano"):
  [`ci/forge-review.mjs`](ci/forge-review.mjs) + workflow
  [`forge-review.yml`](.github/workflows/forge-review.yml) (GitHub, comentários inline) e job
  `forge:review` no GitLab CI. O diff é revisado pelo HubGPU/gateway **interno** — o código não sai
  da empresa. No-op seguro quando `FORGE_LLM_BASE_URL` não está definido.

## [1.2.0] — 2026-06-28

### Added — Fase B: TDD nativo
- **Modo TDD (test-first).** Toggle **TDD** no compositor: o FORGE escreve os
  **testes primeiro** (pytest, "vermelho") e depois a implementação mínima
  ("verde"), entregues como dois diffs aplicáveis.
- **Rodar testes.** Botão **Testes** / comando **FORGE: Rodar testes (pytest)**
  executa a suíte na raiz do workspace e mostra o resultado; em falha, o
  **"Corrigir com FORGE"** realimenta a saída do pytest e itera até o verde.
  Configurável por `forge.test.enabled` / `forge.test.command` (default `pytest -q`).

## [1.1.0] — 2026-06-28

### Added — Fase A do ciclo completo (depois do "Aplicar")
- **Executar com auto-cura.** Botão **Executar** na proposta aplicada (e comando
  **FORGE: Executar arquivo atual**). Detecta o tipo de arquivo, roda localmente,
  captura saída e *exit code*. Em caso de falha, o cartão oferece **"Corrigir com
  FORGE"** — realimenta o erro e gera a correção (loop humano-no-controle). Configurável
  por `forge.run.enabled` / `forge.run.timeoutSeconds` / `forge.run.commands`.
- **Revisão de código in-network ("CodeRabbit soberano").** Comando/botão **FORGE:
  Revisar alterações** revisa o `git diff` do workspace pelo HubGPU — o código **não
  sai da rede**. Revisão multi-lente (correção, segurança, dados/LGPD, performance,
  estilo), em pt-BR, com achados por severidade e correções aplicáveis com um clique.

## [1.0.4] — 2026-06-28

### Changed
- **Tudo em pt-BR para o usuário.** O system prompt agora exige resposta sempre em
  português do Brasil — incluindo o raciocínio/análise do modelo, não só a resposta
  final (evita o "chain-of-thought" em inglês do gpt-oss).
- **Raciocínio recolhível.** O bloco de raciocínio do modelo aparece recolhido por
  padrão (toggle "Raciocínio" / "Raciocinando…"), deixando a resposta em pt-BR em
  primeiro plano e o painel mais limpo.

## [1.0.3] — 2026-06-28

### Changed
- **Identidade do dev passa a ser o e-mail** (antes era o login do SO). O gateway
  usa o e-mail como **`userId`** do trace no Langfuse (o login vira metadado).
- **Coleta do e-mail (RF-063):** usa o `subject` da licença quando ele é um e-mail.
  Quando não há coleta automática (subject genérico/não-e-mail) — ou quando o admin
  ativa `forge.identity.requireEmail` (licenças compartilhadas) — o dev **deve
  informar o e-mail no setup inicial**; sem isso, a configuração não conclui e a
  geração é bloqueada. Novo campo obrigatório no onboarding.

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
