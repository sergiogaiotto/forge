# Changelog

All notable changes to FORGE are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/); versions follow SemVer.

## [Unreleased]

**Endurecimento do gateway + exfil do RAG.** Batch de segurança sobre a fronteira de confiança do gateway
de referência e a via de embeddings do RAG. Cada correção passou por revisão adversarial multi-agente
(6 revisores atacando o código real + verificação independente por achado), que confirmou e fechou 3
defeitos antes do merge — incluindo um **HIGH de exfiltração descoberto na própria revisão** (o `symbol`
do chunk ficava fora da redação). 1019 testes (eram 996).

**FinOps: teto de gasto AUTORITATIVO por tokens/dia (#12).** O gateway passa a enforçar um orçamento de
tokens/dia por subject **assinado na licença** (`issue --budget`), com **402** no proxy quando estoura e um
**ledger durável** (escrita atômica) que sobrevive a restart. A revisão adversarial (4 eixos + verificação
por achado) descobriu e fechou 2 defeitos antes do merge: uma **corrida check-then-charge** que deixava um
burst concorrente furar o teto ~96x (fechada com reserva síncrona no admit + reconciliação no `finally`) e a
escrita não-atômica que um crash corromperia, zerando o teto do dia (fechada com tmp+rename). 1034 testes.

### Added
- **Orçamento de tokens/dia na licença** (`admin-cli issue --budget <n>`): assina o teto por subject
  (0/ausente = ilimitado; licenças antigas seguem ilimitadas — byte-idênticas).
- **Enforcement no gateway** (`gateway/spend.mjs` + `server.mjs`): `overBudget` barra o proxy com **402**
  antes do upstream; uma **reserva** estimada (input + max de saída) é cobrada SINCRONAMENTE no admit para
  que um burst concorrente do mesmo subject não fure o teto, e `settle` reconcilia ao custo REAL no `finally`.
  Ledger por subject+dia (UTC) com rollover, persistido de forma **atômica** (tmp+rename) e exposto em
  `/health.spendPersistOk`. Tokens são a unidade autoritativa (sem tabela de preços server-side).
- **Deterrente + visibilidade no cliente** (`forge.observability.budget`): acumula o **custo estimado da
  sessão** (`estimateCost`), MOSTRA custo + teto no `/contexto` (antes o custo só ia ao trace do Langfuse),
  avisa em ~80% e BLOQUEIA a geração ao atingir o teto (chat, revisão, blueprint e charter; `budgetGateDecision`
  puro). É um deterrente (o teto autoritativo em tokens/dia é do gateway) e só morde com preços configurados.
  O `/limpar` zera a sessão (tokens+custo). Um **402** do gateway aflora com mensagem clara (não JSON cru).
  A revisão adversarial (3 eixos) fechou 4 defeitos antes do merge — incl. o `/limpar` que não zerava o gasto
  (tornando inerte o remédio anunciado no bloqueio) e o gate que pulava blueprint/charter.

### Security
- **Redação do RAG na origem — texto E símbolo** (`CodebaseIndex`/`indexPersistence`): os chunks passam
  a ser redigidos (`redactChunks`) antes de sair pela via de embeddings (endpoint **externo**, fora do
  gateway que redige) e pelo snapshot em disco (globalStorage, texto plano) — duas vias que contornavam a
  redação do prompt. A revisão pegou que redigir só o `text` deixava o `symbol` (a linha-fronteira, ex.:
  `INSERT … 'credencial'`) vazar; agora ambos. `SNAPSHOT_VERSION` 2→3 invalida snapshots com texto cru.
- **Identidade do trace atestada + LGPD** (`server.mjs`/`proxyTrace.mjs`): o `userId` do trace de proxy
  deriva do `subject` **assinado** da sessão (não do header `x-forge-email`, que o cliente controla e
  poderia forjar), mascarado por captura via `attestedUserId` — pseudônimo estável `u_…` em `masked`
  (default), e-mail cru só em `full` (opt-in do Admin). Metadata do trace deixou de despejar e-mail/login
  crus. Fecha o vazamento de e-mail + o spoof + a divergência de hash proxy↔relay. **Mudança visível na
  atualização:** em `masked`, o `userId` passa de e-mail cru para o pseudônimo `u_…` (agrupamento por
  usuário preservado; RF-063 honrado em `full`).
- **Escopo de licença autoritativo** (`server.mjs`/`sessions.mjs`): o gateway (a autoridade — ADR-3/
  RNF-002) exige o escopo `codegen` na ativação contra o payload assinado; `skills` é gateado por
  requisição (best-effort — dirigido pelo header `x-forge-skills`, barra o cliente honesto). Antes o
  escopo era emitido na licença mas nunca enforçado.
- **DoS de sessão** (`server.mjs`/`sessions.mjs`): a ativação não faz mais *force-sweep* de TODAS as
  sessões ao bater o teto (deslogava todo mundo) — expira só as vencidas e, se ainda cheio de sessões
  **vivas**, recusa com 503. `/activate` e `/renew` ganham rate-limit por subject; `/renew` passa a ter
  teto na expiração da licença (uma licença vencida não segue viva via renew).

### Fixed
- **Contagem de tokens invertida no gateway** (`usage.mjs`): `extractUsage` invertia input↔output na
  ordem PADRÃO do OpenAI (prompt antes de completion). Reescrito *order-independent* (lê cada campo pelo
  próprio regex). O shape server-side `{inputTokens,outputTokens}` é mantido de propósito (distinto do
  `{input,output,unit}`+custo do relay do cliente) para não fazer dupla contagem no Langfuse.

## [2.10.0] — 2026-07-10

**FORGE trilíngue + workspace governado.** Fecha os dois itens restantes da gap analysis corporativa:
internacionalização completa (pt-BR/en/es) e a navegação/busca só-leitura do workspace. Todas as 12
fatias (PRs #140–#153) passaram por revisão adversarial multi-agente antes do merge — que confirmou e
corrigiu, ao longo da jornada, 28 defeitos reais (locale congelado por avaliação de módulo, host
vazando string pt-BR pronta pelo protocolo, ramos de prompt gêmeos divergindo, heurística lexical
colidindo entre idiomas e um **ReDoS blocker** medido ao vivo), **nenhum chegando à main**. 893 testes
(eram 834 na 2.9.0).

### Added
- **i18n pt-BR-first completo — pt-BR / en / es** (#140–#152): camada de tradução **própria** (não o
  `vscode.l10n` nativo, arquiteturalmente incapaz de servir inglês a partir de uma fonte pt-BR — o
  inglês é a língua-default do VSCode e curto-circuita o carregamento do bundle). `hostT` no host e `t`
  na webview, com `formatMessage` compartilhado (interpolação `{var}` + mini-ICU plural), fallback
  pt-BR e guards de completude por catálogo. ~1.300 strings em 3 idiomas cobrindo Onboarding, DevPanel
  (o hotspot, ~200 strings), Controller (notices, diálogos nativos, ~30 dataCards), gate/smoke, os
  renderers dos módulos host (git, warehouse, SQL, dbt, PII) e o manifesto (`package.nls.json` inglês
  base + `package.nls.pt-br.json`/`package.nls.es.json` override, com `enumDescriptions` posicionais).
  A paleta "/" resolve label/hint por locale (`COMMAND_EN`/`COMMAND_ES`) com aliases cross-locale; o
  matching (id/aliases) nunca muda. O locale `es` foi a prova de escala: adicionado sem tocar
  `t`/`hostT`/`formatMessage`, só catálogos e aliases.
- **`forge.outputLanguage`** (#151): separa **idioma-da-UI de idioma-da-geração** — o modelo pode
  responder em pt-BR com a UI em inglês, e vice-versa. `auto` (default) segue o locale da UI (en →
  inglês; senão pt-BR); `pt-BR`/`en` fixam. Parametriza só a diretiva de saída dos prompts (o corpus
  segue pt-BR, meta-linguagem para o modelo); resolve na ativação e em runtime.
- **Navegação e busca governadas do workspace** (#153): três comandos só-leitura no padrão do git
  governado — `/arquivos [pasta]` (lista com filtro), `/buscar <regex>` (busca linha a linha) e
  `/todos` (marcadores `TODO/FIXME/HACK/XXX`). O host executa **determinístico** (sem LLM, sem rede,
  sem execução — logo sem gate de trust: ler não roda código do repo, ao contrário do git) e responde
  `data/card`. Governança: `.env`/`.env.*` nunca entram, binários e arquivos >512 KB pulados, tetos de
  arquivos/ocorrências, e **máscara LGPD** nas linhas exibidas.

### Security
- **Anti-ReDoS do `/buscar`** (#153, achado blocker da revisão): o cap de linha barra custo polinomial,
  mas não o backtracking **exponencial** de um quantificador aninhado (`(a+)+` numa linha de 33 chars
  congelava o extension host por ~45 s, síncrono, sem cancelamento — provado ao vivo). Defesa em três
  camadas: `hasNestedQuantifier` recusa star-height ≥ 2 **antes de compilar** (é o único site do repo
  que passava um regex cru do dev ao engine — os irmãos SQL/dbt escapam), orçamento de wall-clock corta
  a varredura residual, e leitura incremental (para de ler no teto de ocorrências ou no deadline).
- **Injeção de markdown no card** (#153): backtick é caractere de nome de arquivo legal — um repo
  hostil podia quebrar o code span; `codeSafe` neutraliza `` ` `` em todo conteúdo vindo do disco
  (path, linha, prefixo).

### Fixed
- **Strings do host vazando pt-BR na UI en** (#147): `preset.note` e a mensagem do teste de embeddings
  eram enviadas prontas pelo protocolo — traduzidas na fonte (`localizedProviderPresets`, `hostT`).
- **Heurística "promover a regra" quebrando entre idiomas** (#148, #152): `\b` é ASCII (o termo en
  `prefer` casava o pt "Preferências"; o es `no use` é diretiva mas idiom em inglês) e radical + `\b`
  era gatilho morto para línguas flexionadas — corrigido com lookahead, `\w*` e gating por locale.
- **Gate de definição-de-pronto sem espanhol** (#153): o detector de "## Como rodar" ganhou os termos
  es (`Cómo ejecutar`) que a doc do manifesto já prometia.

## [2.9.0] — 2026-07-09

**Hardening corporativo — gate autossuficiente, permissões unificadas, E2E e integridade do pacote.**
Continuação da sequência da gap analysis: fechar governança, confiabilidade e distribuição do gerador
governado. Cada PR com revisão adversarial multi-agente antes do merge (PRs #135–#138), que confirmou
e corrigiu defeitos reais (4 bypasses da política de gate, trail de auditoria ilegível na config
default, signature-stripping na verificação do pacote). 834 testes (eram 810 na 2.8.0).

### Added
- **Gate autossuficiente — `forge.gate.blockUnverifiedContract`** (#135): política do admin (Modo
  Projeto, Python) que transforma o contrato cross-file **não verificado** (o mypy não rodou — sem
  toolchain no ambiente) de *confirmação* em **BLOQUEIO sem escape** do Aplicar tudo, do "Forçar
  bloqueados" **e** do Aplicar por-arquivo. Escopo `machine` (workspace não desliga). Caminho de saída:
  "Preparar ambiente" + novo **"Re-verificar contrato"** (re-roda o gate sobre as MESMAS propostas, sem
  regenerar via LLM). Default `false` (confirmação clássica).
- **Permission model unificado** (#136): as decisões de permissão viviam em superfícies ad-hoc (aprovação
  MCP, confirmação de escrita SQL **duplicada**, override de gate, contrato). Agora um `PermissionService`
  central com pipeline único (política › auto-approve só-leitura › perguntar), diálogo nativo e trail de
  auditoria único — **toda decisão** vira o evento `permission.decision` (Langfuse) **e** entra no log de
  diagnóstico local sempre-ligado (com resumo no bundle exportável). Escrita aprovada marca `WARNING` no
  trace; evento de auditoria é isento de amostragem. Cobre 5 superfícies (incl. install de dependências
  inferidas — risco supply-chain).
- **Integridade e proveniência do `.vsix`** (#138): o pacote passa a ser distribuído com um manifesto
  `<file>.integrity.json` — **SHA-256** (integridade, sempre) + **assinatura Ed25519** dos bytes na mesma
  cadeia de confiança das licenças (proveniência, quando o admin assina). Novos `sign-vsix`/`verify-vsix`
  no admin-cli (`npm run sign:vsix`/`verify:vsix`, com `--strict` para EXIGIR assinatura em CI/release e
  fallback à chave pública embutida no cliente); o destinatário confere hash **e** assinatura contra a
  chave pública do admin antes de instalar.
- **Suíte E2E license↔gateway↔provider** (#137): o primeiro teste que integra os **processos reais** —
  sobe o gateway (`gateway/server.mjs`) + um upstream fake, gera chaves/licença pelo admin-cli real e
  dirige activate → proxy (geração) → 401 sem token → **revogação enforçada ao vivo** (403 sem chamar o
  upstream). Fecha o gap "nada sobe gateway + provider ponta a ponta" na fatia fora do extension-host.

### Fixed
- **Gateway trata erro de socket** (#137): `server.listen` sem handler de `error` — um `EADDRINUSE` virava
  exceção não-tratada com stack crua; agora loga estruturado e encerra limpo.

## [2.8.0] — 2026-07-09

**Hardening corporativo — Fases 1 a 3.** Sequência derivada da gap analysis corporativa: o que decide
"corporate solid" no FORGE não é virar agente autônomo, e sim fechar os gaps de governança,
observabilidade e confiabilidade do gerador governado. Três fases, cada uma com revisão adversarial
multi-agente antes do merge (PRs #129–#133), que confirmou e corrigiu defeitos reais de segurança
(bypass de revogação, SSRF por prefixo de hostname, vazamento de captura no relay) e um defeito
funcional de produção no Windows (EINVAL ao spawnar shims `.bat`/`.cmd`). 810 testes (eram 762 na
2.7.0).

### Security
- **Revogação enforçada no gateway** (#129): `gateway/revocations.mjs` (puro, testável) com cache por
  assinatura mtime+size + TTL de 5s e fail-safe (JSON corrompido mantém a última lista boa; cold-start
  corrompido NÃO cacheia a falha — re-tenta e auto-cura). `isRevoked()` roda em **activate, renew E
  proxy** (antes só activate): um subject revogado perde acesso no PRÓXIMO request, sem esperar o
  gateway reiniciar. Subject canonicalizado (trim+lowercase) nos dois lados — e-mail é case-insensitive.
- **Egress sob workspace-trust** (#129): `forge.gateway.url`, `forge.rag.embeddings.url`,
  `forge.observability.langfuse.baseUrl` e `forge.egress.*` viram `restrictedConfigurations` — um repo
  malicioso não redireciona o egress nem injeta host via settings. Novo
  `forge.egress.trustInNetwork` (default `true` = retrocompat): com `false`, só loopback é liberado
  automaticamente; LAN/`.internal`/IP privado exige allowlist. Regex de faixa de IP só se aplica a IP
  **literal** (`net.isIP`) — `127.0.0.1.attacker.com` não vira mais "in-network" por prefixo de string.
- **O relay de observabilidade não confia no cliente** (#131): `gateway/obsRelay.mjs` (puro, testável)
  re-mascara pela política do Admin server-side (`LANGFUSE_CAPTURE` prevalece — cliente em `full` não
  vaza mais prompt cru ao Langfuse governado), **carimba a identidade da sessão** (userId/org/environment
  vêm da sessão, não do payload — anti-impersonação), amostra **por-trace** (não fragmenta traces com
  `sampleRate<1`) e capa 500 eventos por request (anti-DoS da fila compartilhada).

### Added
- **Observabilidade governada — GatewayRelaySink** (#130): eventos de workflow (aplicar/gate/run/revisão,
  que nunca passam pelo proxy de geração) agora chegam ao Langfuse **via gateway** (`POST /obs/ingest`,
  autenticado pelo token de sessão + revogação + rate limit) — a `secretKey` do Langfuse fica SÓ no
  servidor. Novo `forge.observability.mode` (`off`|`direct`|`gateway`; legado `enabled=true` ⇒ `direct`),
  com `RoutingObsSink` roteando e drenando resíduo na troca de modo. Fail-open, egress-checked.
- **Custo em R$ (FinOps)** (#130): tabela de preços **configurável** por modelo
  (`forge.observability.pricing`; vazio = nenhum custo — o FORGE não fabrica preço) com moeda
  configurável; `inputCost`/`outputCost`/`totalCost` anexados à usage da geração no Langfuse.
  `sanitizePricing` exige número real (rejeita coerções `''`→0, `true`→1) — não subvaloriza custo.
- **Persistência do índice RAG + embedding incremental** (#132): snapshot do índice no `globalStorage`
  (vetores em base64 Float32) com reconciliação por mtime+size — o build REUSA chunks e vetores dos
  arquivos que não mudaram e só re-embeda o que mudou; `rebuildRetrieval` embeda só chunks SEM vetor
  (antes re-embedava o codebase inteiro a cada build e a cada save). Escrita atômica (temp+rename),
  poda de snapshots órfãos (>60d), teto de chunks vira aviso VISÍVEL ao dev (não trunca em silêncio).
  Se o modelo de embeddings mudou, re-embeda tudo.

### Fixed
- **Spawn de shims `.bat`/`.cmd` no Windows** (#133): o Node recusa `.bat`/`.cmd` sob `shell:false`
  (EINVAL, CVE-2024-27980) — Oracle SQLcl (`sql.bat`) e BigQuery (`bq.cmd`) quebravam no Windows.
  `buildSpawn` agora roteia shims por shell com caminho+args quotados manualmente (seguro: `unsafeField`
  já rejeita metacaracteres nos settings); `.exe`/POSIX seguem `shell:false`. O teste de spawn exercita
  um shim `.cmd` REAL (teste com `node.exe` mascarava o bug) e prova que metacaractere é literal.
- **Links do changelog/readme embutidos no `.vsix`**: o `vsce package` reescrevia links relativos sem
  a rota de arquivo do GitLab (`/-/blob/<ref>/`), gerando 404 na página da extensão; o
  `baseContentUrl`/`baseImagesUrl` agora apontam para `/-/blob/main` e `/-/raw/main`.
- **Drift de dimensão no cache de vetores do RAG** (#133): o rebuild verifica HOMOGENEIDADE de
  comprimento entre cache e endpoint (re-embeda tudo se divergem — dims da config `0=default` não é
  confiável) e o cosine retorna 0 para dimensões diferentes (não trunca por `Math.min` → score espúrio).
  Falha transitória de embed não rebaixa um snapshot de embeddings para lexical.

## [2.7.0] — 2026-07-09

**FORGE Dados — o salto para engenharia de dados.** Quatro ondas que dão ao FORGE uma *camada
determinística* de dados: o LLM raciocina, motores compilados validam. Inspirado no estudo do
altimate-code/ADE-bench (harness > modelo), mas 100% aberto e embutível — sem driver nativo no `.vsix`.
Puramente aditivo e fail-open: sem projeto dbt / sem conexão configurada, o comportamento é idêntico ao
anterior. Cada onda com revisão adversarial multi-agente (PRs #125, #127) — que confirmou e corrigiu
38 defeitos antes do merge, incluindo um RCE e dois bypasses de governança.

### Added
- **Motor SQL determinístico** (#125): módulo `src/sql/` puro-TS (sem dependências novas) — léxico
  robusto (escapes `''`/`\'`, dollar-quoting, identificadores quotados), pré-processador **Jinja/dbt**
  (`{{ ref() }}`/`{{ source() }}` viram os identificadores reais — analisa modelo dbt cru, o calcanhar
  declarado do altimate), classificador de statements e **16 regras anti-padrão** com confiança
  declarada. Novo gate `forge.gate.sql` (`conservative` padrão): só achados de **segurança**
  (DELETE/UPDATE sem WHERE, DROP/TRUNCATE, produto cartesiano) bloqueiam o Aplicar; o resto é advisory.
  Roda **in-process** em toda proposta `.sql` (chat, TDD, Modo Projeto), no mesmo canal de card/gate/Langfuse.
- **Grounding dbt** (#125): índice de `target/manifest.json` (+`catalog.json`) com recarga por mtime; o
  **schema real entra no prompt** (anti-alucinação) e um **gate semântico** acusa tabela/coluna
  inexistente com sugestão ("você quis dizer …?"). Em projetos dbt, analisa o SQL compilado — melhor
  onde mais importa.
- **Lineage de coluna + raio de explosão** (#125): `src/sql/lineage.ts` (column-level determinístico,
  atravessa CTEs) e comando **`/impacto [modelo]`** (host-computado do manifest: downstream, testes,
  exposures). Lente "dados" no `/revisar` injeta os achados do motor como evidência determinística.
- **Skills 2.0 de dados** (#125): dbt/sql/airflow/spark reescritas com disciplina de workflow
  (descoberta de convenções, escada de verificação, regra das 3 falhas, tabelas CAN/CANNOT de
  preservação semântica). Comandos **`/traduzir-sql <dialeto>`** e **`/testes-dbt [modelo]`** (schema.yml
  ancorado nas colunas reais do manifest).
- **Conexões de warehouse governadas** (#127): o dev conecta pelo **caminho tradicional** (os CLIs que
  já usa) ou por **MCP**. Cobertura: **Oracle 19c/26ai/Exadata/ADW** (SQLcl/sqlplus + wallet→TNS_ADMIN),
  **PostgreSQL** (psql), **BigQuery** (bq), **DuckDB**, **S3 / OCI Object Storage** (aws/oci). Nenhum
  driver embutido — spawna o CLI do dev (padrão pytest/mypy/tesseract). **Governança por motor**: SELECT
  roda; escrita exige `readonly:false` + confirmação modal; DROP/TRUNCATE e blocos PL/SQL nunca. Senha no
  SecretStorage (via wrapper `/nolog`/PGPASSWORD, jamais em argv/log); saída capada e mascarada (LGPD).
  Comandos `/conexoes`, `/executar-sql [conn]` (com auto-cura), `/custo` (dry-run/EXPLAIN).
- **Schema vivo do warehouse** (#127): `/schema-db [conn]` inventaria as colunas por dialeto e **funde ao
  índice dbt** — o grounding anti-alucinação passa a valer fora de projetos dbt.
- **Paridade, FinOps e auditoria LGPD** (#127): `/paridade a b [conexao:tabela]` (profile-diff por
  agregados — nenhuma linha sai do banco; intra e entre warehouses), `/custo` FinOps 7d (BigQuery JOBS,
  pg_stat_statements, Oracle v$sql), `/auditoria-pii` (dicionário LGPD por nome de coluna, 100% local,
  com sugestão de mascaramento por dialeto). Novos settings `forge.warehouse.*`.

### Security
- **Workspace-trust** (#127): `forge.warehouse.connections`, `forge.mcp.catalog`, `forge.run.commands`
  e afins passam a ser `restrictedConfigurations` — settings que definem comandos executáveis são
  ignorados em workspace não confiável. O spawn de CLI não usa mais `shell:true` (resolve o binário no
  PATH e deixa o Node quotar os args), fechando injeção de comando via string de conexão.

## [2.6.0] — 2026-07-08

**Auto-detecção da janela de contexto servida pelo gateway.** Fecha o último gap da auditoria de campo
(Q1). Cada PR com revisão adversarial multi-lente.

### Added
- **Janela servida auto-detectada** (#123): o catálogo tem a capacidade do *modelo* (128k do gpt-oss-120b),
  mas o vLLM/HubGPU pode servir com `--max-model-len` menor — e o orçamento de contexto, confiando nos 128k,
  estouraria (**HTTP 400** em toda geração). Agora o FORGE consulta o `GET /v1/models` (o vLLM expõe
  `max_model_len`) **uma vez por provedor** e reconcilia o orçamento com o que o gateway realmente serve,
  quando o admin não fixou `forge.provider.maxContextWindow`. **Drop-in seguro**: sem detecção (falha /
  provedor não-vLLM / override manual) o comportamento é idêntico ao anterior (usa o catálogo); a janela
  detectada nunca sobe acima do catálogo (`Math.min`). Fail-open em qualquer erro de rede.

## [2.5.0] — 2026-07-08

**Modo Projeto que roda de fato — do gerar ao browser.** Uma sessão de uso end-to-end (gerar um projeto pelo
motor real gpt-oss-120b/HubGPU, aplicar e subir a aplicação no navegador) expôs e corrigiu as causas-raiz que
faziam o FORGE selar como "pronto" um projeto que não roda. Mais o gate de arquitetura Java (P4) e o picker de
menção "@". Cada PR (#117–#121) com revisão adversarial multi-lente — que pegou um bug crítico em vários deles
(comando não-invocável no PowerShell; corrupção silenciosa de código harmony-domain) antes do merge.

### Added
- **Java · gate de arquitetura por pacote (P4)** (#117): a regra de camadas (o domínio não importa a infra)
  roda sobre os imports Java por pacote declarado; o gate de compilação `javac` fica de follow-up (sem JDK
  validável no host, não se escreve o classificador de erros às cegas).
- **Menção "@" no chat** (#118): picker inline de arquivos/pastas do workspace direto no composer.
- **"Aplicar e executar" sobe servidores FastAPI** (#119): o RunService detecta um app ASGI (FastAPI) pelo
  conteúdo e sobe `uvicorn <módulo>:app` num terminal dedicado, abrindo o navegador na URL real — em vez de
  `python arquivo.py`, que só instancia o app e sai (exit 0) sem servir. Interpretador resolvido RELATIVO ao
  cwd para invocar no PowerShell (shell padrão no Windows).
- **Confirmação de contrato não verificado** (#121): num projeto Python que compilou mas cujo mypy NÃO rodou
  (sem venv/mypy), o "Aplicar tudo" passa a exigir confirmação explícita ("Aplicar sem verificar contrato") em
  vez de gravar em silêncio como se estivesse verde — a coerência cross-file (import/atributo fantasma) não foi
  checada. Só Python (em Go/Java o compilador de contrato é advisory de propósito); escape auditável de 1 clique.

### Fixed
- **Modo Projeto Python roda de fato** (#119): o manifesto de dependências passa a ser `requirements.txt` (não
  `pyproject.toml`) — é ele que ativa a reconciliação anti-drift que confere se o código importa o que o
  manifesto declara; os `__init__.py` reais são materializados no Aplicar (o gate só criava sintéticos numa
  árvore temp); e o prompt exige um entrypoint executável (`uvicorn.run` em `__main__`), Pydantic v2, `Form(...)`
  para formulários HTML e o diretório de templates resolvido por `__file__` (robusto ao CWD).
- **Vazamento harmony do gpt-oss na geração** (#120): o preâmbulo de análise que o streaming às vezes vaza no
  `content` (antes do 1º bloco `forge-file`) é saneado; o CONTEÚDO dos arquivos fica verbatim — um `.py` que
  contém `assistantfinal`/`<|channel|>…` como literal (o domínio do FORGE é parsear gpt-oss) não é mais
  corrompido em silêncio.

## [2.4.0] — 2026-07-07

**Auditoria da geração de código — os 4 pilares.** Uma auditoria multi-agente da geração no Modo Projeto
apontou a causa-raiz do "copiar/colar" (só o bloco `forge-file` vira proposta aplicável; em turnos de
remediação o modelo desviava do protocolo e o próprio FORGE o induzia) e endereçou quatro frentes: tornar o
**Aplicar** o caminho natural (P1), promover **convenções a gate duro** no host (P2), dar **observabilidade
local** sempre-ligada (P3) e provar que o **projeto de fato roda/compila** em mais linguagens (P4). 14 PRs
(#102–#115), cada um com revisão adversarial multi-lente e defeitos provados ao vivo antes do merge.

### Added — P1 · Apply-first (o Aplicar como caminho natural)
- **Reparo de protocolo pós-stream**: quando o modelo mostra o código em cerca comum (` ```py `) em vez de
  `forge-file`, o FORGE detecta o desvio e **reemite os arquivos como proposta aplicável** numa chamada
  silenciosa (sem inferir caminho no cliente — usa o `path=` que o modelo já conhece). Detector conservador:
  menção didática não dispara.
- **"Salvar como arquivo" no bloco de código**: para o caso residual, um botão sintetiza uma **proposta real**
  (mesmo gate, mesma contenção `safeWorkspacePath`) a partir de um trecho em cerca comum.
- **Escape consciente do gate**: **"Aplicar assim mesmo, revisei"** (e "Forçar bloqueados" no Aplicar-tudo)
  pula só o guard do gate — a contenção de caminho segue valendo — com override **auditável** (WARNING na
  observabilidade).
- **Few-shot vivo no histórico**: o turno anterior passa a empilhar o **próprio output** do modelo (cabeçalhos
  `forge-file` preservados) em vez do stub "Apliquei em X", para o modelo ver seu protocolo no próximo turno.

### Added — P2 · Convenções como gate duro
- **Gate de arquitetura (regra de ouro)**: uma _fitness function_ (estilo import-linter/ArchUnit) bloqueia o
  Aplicar quando a camada interna (domínio/entidades/model) importa a externa (adapters/infra/repository).
  Detecção conservadora: só bloqueia quando o import resolve, sem ambiguidade, para arquivo(s) gerado(s) da
  camada externa.
- **Gate de definição de pronto (DoD)**: "o projeto tem o mínimo para instalar e rodar?" — manifesto de
  dependências, ≥1 teste, e um README com "como rodar". A falta fecha o Aplicar de todos (o universo é o
  projeto inteiro: propostas desta rodada + arquivos já aplicados).
- **Gate de segurança (SAST/bandit)**: análise por AST do código gerado; bloqueio **conservador** (só
  severidade **e** confiança altas, em execução de código/shell) — o resto é advisory. Fail-open sem a
  ferramenta.
- **Templates de scaffold determinístico**: uma skill pode declarar `templates` no frontmatter; ao ativar no
  Modo Projeto, o FORGE **materializa o `.tmpl` como arquivo — fora do LLM (determinístico)** — em _gap-fill_
  (nunca sobrescreve o que o modelo gerou nem um arquivo existente no disco). O arquivo herda o gate.

### Added — P3 · Observabilidade local
- **Log de diagnóstico local sempre-ligado**: um _tee_ redigido dos eventos vai para o `globalStorage` antes
  do gate de egress remoto (o remoto segue opt-in). Comando **"FORGE: exportar diagnóstico"** gera um bundle
  redigido. Retenção de 7 dias.
- **Prompt de sistema montado + parâmetros efetivos** capturados no `generation.start` (reasoning effort,
  máximo de tokens, orçamento de entrada) e **spans de fase** (montagem/RAG/stream/continuação/gate/reparo).
  Privacidade: o prompt de sistema (que agrega perfil/RAG/anexos) só vai ao sink remoto em captura _full_;
  masked/metadata-only omitem; o log local redige em duas camadas.

### Added — P4 · Projeto que de fato roda
- **Gate multi-linguagem**: além de Python (`compileall` + `mypy`), o gate do Modo Projeto agora cobre
  **TypeScript** (`tsc --noEmit` — sintaxe bloqueia, tipo é advisory sem `node_modules`) e **Go** (`gofmt`
  sintaxe bloqueia; `go build ./...` compilação/drift é advisory, offline). A **regra de arquitetura** roda
  nas três linguagens.
- **Smoke test advisory**: depois do gate estático verde, tenta **rodar a suíte gerada** no venv do workspace
  (o sinal "de fato roda"). Nunca bloqueia e nunca instala nada; pulado se o gate bloqueou por segurança/
  arquitetura.
- **Reconciliação de dependências**: pré-entrega, acrescenta ao `requirements.txt` gerado os pacotes que o
  código importa mas não declara — re-postando o cartão do manifesto.

## [2.2.0] — 2026-07-05

Geração de projeto **auto-curável**: o Modo Projeto agora detecta, bloqueia e conserta sozinho o drift
de contrato entre arquivos — o defeito que fazia um projeto gerado "completo" não rodar (ex.: um
`import` de símbolo que nenhum arquivo define derrubando o app no boot). Três ondas.

### Added
- **Gate de compilação workspace-wide (Onda 1)**: antes do "Pronto", o Modo Projeto materializa TODAS as
  propostas juntas (com `__init__.py` sintéticos) e roda `compileall` + `mypy` sobre o CONJUNTO, pegando
  o drift de contrato cross-file (import/atributo fantasma) que a validação por-arquivo isolada não vê. O
  arquivo reprovado tem o "Aplicar" bloqueado. Degradação segura: sem as ferramentas, o gate é consultivo.
- **Garantia de mypy + estado "parcial" honesto (Onda 1.5)**: o gate instala o `mypy` no venv do projeto
  best-effort (só no venv, nunca no python global) — sem ele, `compileall` só veria sintaxe e o drift
  passaria. Quando a coerência não pôde ser verificada, o cartão do gate mostra "parcial" em âmbar, em vez
  de se disfarçar de verde.
- **Auto-reparo dirigido pelo gate (Onda 2)**: quando o gate reprova, o FORGE re-pede ao modelo SÓ os
  arquivos reprovados — com os erros exatos do `mypy` e o CONTEÚDO REAL dos arquivos que passaram (o
  contrato a copiar) — e re-roda o gate, até verde ou o teto de 2 rodadas. As propostas são substituídas
  no lugar (sem cartão duplicado). O gate continua bloqueando o Aplicar se não fechar: nunca entrega um
  projeto quebrado em silêncio.

## [2.1.5] — 2026-07-04

Robustez definitiva contra o truncamento e o vazamento harmony do gpt-oss/HubGPU, validada por
teste vivo contra o modelo real. Cinco PRs.

### Fixed
- **Vazamento harmony no "Redigir com IA" (e no Blueprint/resumir)**: no streaming o gpt-oss/HubGPU
  vaza o canal de análise dentro do `content`, grudado na resposta ("max 2 sentences. Provide 2
  sentences.O aplicativo…"). As tarefas one-shot estruturadas (charter/blueprint/resumir) passam a
  rodar em **não-streaming**, onde o raciocínio fica isolado em `reasoning_content` — o vazamento
  some (comprovado ao vivo). Como bônus, o `finish_reason` vem confiável no corpo (base do salvage/
  continuação).
- **Corte "sem sinal" do Charter**: o HubGPU às vezes corta por limite de tokens mas reporta
  `finish_reason=stop` em vez de `length`. A continuação do charter ganha uma **heurística estrutural
  conservadora** de reforço (hífen de quebra pendurado ou palavra de ligação pt-BR no fim) — listas de
  RF/RNF, rótulos e siglas nunca disparam.
- **stripHarmony endurecido** (defense-in-depth): reconhece mais frases de controle harmony como
  preâmbulo de linha isolada, sem nunca cortar prosa grudada (que destruiria código).

### Added
- **Seletor de `max_tokens` (tokens de saída)** no rodapé do composer e comando de paleta
  **"FORGE: definir máximo de tokens de saída"** — presets `auto/16k/32k/64k/128k`, rebaixados
  automaticamente à janela realmente servida pelo gateway (sem erro 400). O HubGPU aceita até 128k.
- **Heartbeat por timer** no modal do Blueprint (o não-streaming não tem chunks de progresso).

### Changed — Interface
- **Barra do composer enxuta**: mantém só **Anexar contexto → Projeto → TDD → modelo atual** (os
  seletores de linguagem/arquitetura/UI/framework aparecem apenas com o Modo Projeto ligado). Testes,
  Ambiente, Índice, Perfil e Papel saíram da barra e ganharam **comandos de paleta** ("FORGE: …"); os
  slash `/ambiente` `/testes` `/indice` `/perfil` seguem funcionando. O rótulo do provedor
  ("HubGPU/compat · modelo") foi removido do rodapé — o modelo continua visível no composer.

## [2.1.4] — 2026-07-04

### Fixed
- **Charter truncado no "Redigir com IA"** (caso do print: Propósito entregue cortado): o FORGE agora
  **continua a redação automaticamente** quando o provedor corta por limite de tokens (até 2 emendas,
  com costura que saneia o vazamento harmony por rodada, preserva o ponto exato do corte e remove
  repetição do modelo). O aviso ancorado na seção vira último recurso — e ficou honesto: só menciona
  a continuação automática quando ela de fato rodou. Um erro no meio da emenda entrega o parcial com
  aviso em vez de descartar o texto já gerado.

### Changed
- **Campos vazios do Charter derivam do Propósito**: "Redigir com IA" em Regras/Requisitos com o campo
  vazio usa o **Propósito como escopo** — e o wizard passa a enviar as seções como estão na tela
  (inclusive texto ainda não salvo) como contexto da redação.

## [2.1.3] — 2026-07-03

### Fixed
- **Blueprint cortado sem sinal de truncamento** (caso do print: `finish_reason=stop` com o plano
  `{"files":[…]}` interrompido no meio): o reparo agora roda **mesmo sem o sinal** de limite —
  protegido pelo piso de 2 arquivos, pela seleção pelo candidato mais tardio e pelo aviso de "plano
  parcial" no modal. Um eco de exemplo fechado antes do plano não bloqueia mais o resgate. E a
  **conversão roda primeiro** (frequentemente recupera o plano completo), com o parcial reparado
  como fallback garantido — o "Tentar de novo" deixa de ser a única saída.

## [2.1.2] — 2026-07-03

### Fixed
- **Blueprint com JSON garantido pelo decoder**: o planejamento agora pede
  `response_format: json_object` (guided decoding do vLLM/OpenAI) — o servidor só emite JSON válido,
  eliminando de vez a loteria do parse. Gateways sem suporte ganham **degradação automática** (uma
  reemissão sem o campo; todo o pipeline tolerante anterior segue como rede de segurança).

### Added
- **Seletor de framework web para projetos Python**: com Projeto ligado e Python selecionado, escolha
  entre **FastAPI, Flask ou Litestar** (ou deixe em "auto") — a escolha entra no blueprint e na
  geração como instrução explícita, convivendo com o seletor de camada de UI.

## [2.1.1] — 2026-07-03

### Fixed
- **Blueprint que ainda falhava com "sem array válido, mesmo após pedir a conversão"** (caso real:
  app FinOps com template engine). Três elos: a **conversão recebia só o começo** da resposta anterior
  (o array do fim era descartado pelo cap — agora o cap é bipartido e preserva as duas pontas); a
  **2ª tentativa repetia a mesma falha deterministicamente** (temperature 0 — agora amostra com o
  default do servidor, e o "Tentar de novo" passa a variar de verdade); e o **plano completo escrito
  no raciocínio era descartado** quando o gateway roteava tudo para `reasoning_content` sem marcador
  (resgate estrito por candidato mais tardio, com piso de 2 arquivos contra ecos de schema).
- A mensagem de erro do blueprint agora inclui o **início da resposta recebida** — diagnóstico
  instantâneo sem abrir o Output → FORGE.

## [2.1.0] — 2026-07-03

### Added — Paleta de comandos "/"
- **Digite `/` no chat** para a paleta com autocomplete (↑↓/Enter/Tab/Esc; acentos normalizados —
  `/sumário` ≡ `/sumario`). Comando só executa **nu e exato**: "/testes estão falhando?" é pergunta
  e vai ao modelo; typo orienta sem apagar o rascunho.
- **`/contexto`** — orçamento REAL da janela (mesmo cálculo da geração): janela, reservas, fixo,
  histórico, anexos pendentes na barra de ocupação, RAG e uso da sessão.
- **`/tokens`** + medidor na barra de status — uso real de tokens (última geração + acumulado; inclui
  gerações que falharam no meio, charter e blueprint).
- **`/limpar`** — limpa a conversa DE VERDADE (histórico e anexos do host; aborta geração em voo).
  Corrige o bug do "Nova conversa" que só limpava a tela e o modelo seguia vendo o histórico antigo.
- **`/resumir`** — compacta o histórico num resumo técnico (libera janela sem perder o fio), com
  guarda de concorrência (nunca perde turnos) e cartão mostrando o que o modelo passa a receber.
- **`/revisar`** — revisão multi-lente das alterações (espelho do botão).
- **`/diagrama [tema]`** — diagrama Mermaid da codebase como proposta versionável em `docs/diagramas/`.
- **`/sumário projeto`** — documentação funcional padrão de mercado (12 seções, fiel ao código, data
  real injetada) como proposta em `docs/SUMARIO_FUNCIONAL.md`.
- Atalhos: `/ambiente` `/testes` `/perfil` `/indice` `/projeto` `/ajuda`.

### Added — Ambiente e testes autocuráveis
- **Preparar ambiente cria tudo do zero**: sem `requirements.txt`/`pyproject`, os imports do código
  viram um `requirements.txt` gerado (docstrings/locais/stdlib filtrados; mapa PyPI: sklearn→
  scikit-learn etc.); com requirements existente, **incrementa com confirmação**. Timeout próprio
  (`forge.env.timeoutSeconds`, 900s) para pip pesado.
- **"Executar" usa o venv do projeto** — fim do `ModuleNotFoundError` com ambiente preparado; cartão
  de falha por dependência oferece "Preparar ambiente".
- **Testes com pré-flight**: pytest ausente → instala no venv com confirmação (ou
  `forge.test.autoInstall`); sem venv, cria o ambiente completo antes. Estado "pytest ausente" é
  neutro-acionável (botão "Instalar pytest e rodar"), não erro morto. Projeto Node com script `test`
  real usa `npm test` automaticamente.

### Added — Modo Projeto e papel
- **Seletor opcional de camada de UI** no Modo Projeto: auto (modelo decide), sem UI, **template
  engine** (Jinja2/EJS/Thymeleaf/html-template conforme a linguagem), SPA React ou Streamlit (Python).
  A escolha entra no blueprint e na geração; o retry a reenvia.
- **Papel transparente**: escolher o papel mostra um cartão com a linha de estilo que entra em todo
  prompt e as skills relacionadas — chips clicáveis abrem direto o SKILL.md no Índice.

### Changed — Modais
- **Perfil do projeto**: 640px em grid de 2 colunas, header/footer fixos e scroll só no miolo (em
  laptop de pouca altura os botões exigiam rolagem).
- **Índice**: navegação empilhada — lista em largura total com descrição; detalhe em tela cheia com
  "← voltar" (as colunas espremidas dificultavam a leitura).

## [2.0.2] — 2026-07-01

### Fixed
- **Blueprint que ainda falhava com "resposta sem blueprint válido" em campo (HubGPU/gpt-oss).** O
  gateway pode rotear a resposta inteira para o canal de raciocínio (`reasoning_content`) — o content
  chega vazio — e o "Tentar de novo" repetia a mesma requisição determinística. Agora: (1) o plano é
  procurado também no **canal de raciocínio**, mas só após o marcador de canal final (o CoT bruto ecoa
  o schema do prompt — parseá-lo fabricaria plano falso); (2) sem plano na 1ª tentativa, uma **2ª
  chamada automática pede a conversão da própria resposta anterior** no array JSON exato; (3) plano
  com menos de 2 arquivos é inválido (projeto completo tem manifesto+código+README) e escala para a
  conversão; (4) o Charter ganhou o mesmo resgate conservador.
- **`temperature: 0` nas tarefas estruturadas** (blueprint/charter) para saída determinística — exceto
  nos modelos de raciocínio da OpenAI (o-series/gpt-5), que rejeitam o parâmetro com 400 e não o recebem.
- **Diagnóstico de campo**: toda falha do blueprint/charter grava no painel **Output → FORGE** o que
  chegou de verdade (tamanhos e trechos de content/raciocínio); a mensagem de erro aponta para lá e
  distingue as causas (truncou / respondeu sem array / veio vazio). O planejamento do blueprint agora
  emite trace de observabilidade (Langfuse).

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
