<div align="center">

# 🔥 FORGE — Codegen Claro

**Geração de código assistida por IA para times de dados e IA, dentro do VS Code — governada, ancorada no seu código e capaz de rodar 100% dentro da rede da empresa.**

Multi-provedor (HubGPU · OpenAI · Anthropic) · Skills especializadas · Motor de dados (SQL/dbt/warehouse) ·
Quality gates locais · RAG do seu código · Perfil de projeto · MCP in-network · FinOps & Observabilidade · Operação offline.

</div>

---

> **Para quem é este guia.** Você é dev — cientista de dados, engenheiro de dados/ML/IA ou de software — e quer extrair **todo** o valor do FORGE no dia a dia. Este README explica **cada funcionalidade** de forma acessível: o **fundamento** (o conceito por trás), o **benefício** (por que te ajuda) e um **exemplo** de uso. Não é preciso conhecer o produto de antemão. Se quiser um passo a passo ainda mais detalhado, veja o [Guia do Usuário](docs/GUIA-DO-USUARIO.md); se você administra a instalação, veja o [Guia do Admin](docs/GUIA-DO-ADMIN.md).

## Índice

1. [Fundamentos — o que é o FORGE, em linguagem simples](#1-fundamentos--o-que-é-o-forge-em-linguagem-simples)
2. [Instalação, licença e provedores](#2-instalação-licença-e-provedores)
3. [Conversar e gerar código (o dia a dia)](#3-conversar-e-gerar-código-o-dia-a-dia)
4. [A paleta de comandos `/` — referência rápida](#4-a-paleta-de-comandos--referência-rápida)
5. [Skills — o conhecimento especializado embutido](#5-skills--o-conhecimento-especializado-embutido)
6. [Modo Projeto — gerar um projeto inteiro que roda](#6-modo-projeto--gerar-um-projeto-inteiro-que-roda)
7. [Quality gates — o código já nasce revisado](#7-quality-gates--o-código-já-nasce-revisado)
8. [Motor de dados — SQL, warehouse e dbt](#8-motor-de-dados--sql-warehouse-e-dbt)
9. [RAG — o FORGE conhece o SEU código](#9-rag--o-forge-conhece-o-seu-código)
10. [Perfil do projeto — papel, regras e stack](#10-perfil-do-projeto--papel-regras-e-stack)
11. [Segurança e privacidade](#11-segurança-e-privacidade)
12. [FinOps e observabilidade](#12-finops-e-observabilidade)
13. [Utilitários — navegação, busca, git, MCP, OCR, CI/CD](#13-utilitários--navegação-busca-git-mcp-ocr-cicd)
14. [Referência: configurações (settings)](#14-referência-configurações-settings)
15. [Referência: comandos do VS Code](#15-referência-comandos-do-vs-code)
16. [Mais documentação](#16-mais-documentação)

---

## 1. Fundamentos — o que é o FORGE, em linguagem simples

O FORGE é uma **extensão do VS Code** que coloca um assistente de IA de geração de código ao lado do seu editor. Você descreve uma tarefa em português; ele gera o código, mostra um **diff** (as linhas que vai adicionar/remover) e só aplica com a sua confirmação. Até aqui, parece um copiloto comum — a diferença está em **cinco ideias** que valem a pena entender antes de mergulhar nas funcionalidades:

- **Governança.** Nada acontece sem regra. A decisão de rodar um SQL, aplicar um arquivo ou chamar uma ferramenta externa passa por verificações **determinísticas** (código, não "a IA achou que podia"). Você mantém o controle e a auditoria.
- **Grounding (ancoragem).** Em vez de inventar nomes de funções e colunas, o FORGE **lê o seu código e o seu banco** e gera usando o que existe de verdade. Menos alucinação, menos retrabalho. Isso vem do **RAG** (ver §9) e do **grounding de dados** (ver §8).
- **In-network / soberania de dados.** O FORGE foi feito para rodar **dentro da rede da empresa**: os modelos de IA podem ser os do HubGPU interno da Claro, os embeddings são in-network, e o FORGE **não navega na internet pública** por padrão. Seu código privado não vaza.
- **Offline-first.** Ele funciona **desconectado da internet pública**. A licença é verificada por criptografia offline; se o serviço de busca semântica cair, ele degrada para busca por palavras; a telemetria é desligada por padrão.
- **O código nasce revisado.** Toda geração passa por um **quality gate** local (linter, checagem de tipos, análise de segurança, testes) antes de você poder aplicar. Você recebe código que já compila e passa nos padrões do projeto.

Guarde esses cinco pilares — todas as funcionalidades abaixo são aplicações deles.

**Provedores de IA suportados.** O FORGE conversa com três tipos de "cérebro":
- **HubGPU (Claro)** — endpoints internos compatíveis com OpenAI, com presets prontos para `openai/gpt-oss-120b` e `gpt-oss-20b`. É a opção soberana (nada sai da rede).
- **OpenAI** — API oficial (quando autorizada).
- **Anthropic (Claude)** — API nativa (quando autorizada).

O streaming (a resposta aparecendo aos poucos) é uniforme entre os três, com timeout de segurança.

---

## 2. Instalação, licença e provedores

### 2.1 Instalar a extensão

O FORGE é distribuído como um arquivo `.vsix` (um pacote de extensão do VS Code).

1. No VS Code, abra a aba **Extensions** (`Ctrl+Shift+X`).
2. No menu `⋯` (canto superior direito da aba) → **Install from VSIX…**.
3. Selecione o `forge-win32-x64-2.15.0.vsix` que você recebeu.
4. Recarregue quando pedido. Um ícone 🔥 **FORGE** aparece na barra lateral (activity bar).

> **Pré-requisitos:** VS Code **≥ 1.93**. Para funcionalidades opcionais: um CLI de banco no PATH (para SQL — ver §8), o `tesseract` (para OCR — ver §13) e `git` (para os comandos de git). Nenhum deles é obrigatório para o uso básico de codegen.

### 2.2 Ativar a licença (Ed25519, offline)

**Fundamento.** O FORGE é desbloqueado por uma **chave de licença assinada digitalmente** e verificada por criptografia (**Ed25519**), **inteiramente offline** — não há "ligar para casa". O fornecedor guarda uma chave privada secreta; o cliente traz embutida apenas a chave pública, que confirma a assinatura sem nunca revelar a privada.

**Benefício.** Funciona numa rede corporativa isolada (air-gapped), sem depender da internet — e, mesmo assim, um admin que rode o **gateway** consegue **revogar** o acesso de alguém centralmente quando necessário.

**Exemplo.** Abra a paleta (`Ctrl+Shift+P`) → **FORGE: Ativar licença** e cole a chave (`FORGE-eyJ...`). Uma chave válida, no prazo e com escopo `codegen`, ativa na hora (modo local). Para governança central, o admin define `forge.license.mode = gateway` e `forge.gateway.url`, e a validação passa a ser autoritativa no servidor.

| Modo | Setting | Quando usar |
|---|---|---|
| **Local** (padrão) | `forge.license.mode = local` | PoC, desenvolvimento, rede isolada. Verificação só no cliente (dissuasória). Tudo offline. |
| **Gateway** | `forge.license.mode = gateway` + `forge.gateway.url` | Governança corporativa: validação autoritativa, proxy de inferência, revogação, teto de gasto e observabilidade central. |

### 2.3 Escolher o provedor

Rode **FORGE: Configurar provedor** (`forge.setupProvider`) e informe o endpoint e a chave. A chave de API é guardada **no cofre criptografado do sistema operacional** (SecretStorage) — nunca em `settings.json` nem em logs (ver §11). Para o HubGPU, os presets `gpt-oss-120b`/`gpt-oss-20b` já vêm prontos.

### 2.4 Primeira geração (o "hello world")

Abra um arquivo, abra o painel do FORGE (🔥) e descreva a tarefa, por exemplo:
> *"Limpe o `churn.parquet`: remova duplicados, ajuste os tipos e trate nulos com segurança."*

O FORGE ativa a skill `pandas-defensive-pipelines`, transmite a resposta ao vivo, propõe um **diff**, roda **ruff + mypy** localmente e só libera o botão **Aplicar** se o gate passar. Pronto — você viveu o ciclo central: *descrever → gerar → revisar → aplicar*.

---

## 3. Conversar e gerar código (o dia a dia)

Esta é a área que você mais usa. Cada item abaixo é uma funcionalidade do painel de chat.

- **Chat com streaming.** *Fundamento:* a resposta da IA aparece token a token, ao vivo, dentro de um **cartão de proposta**. *Benefício:* você vê o raciocínio e o código surgirem e pode cancelar cedo se for pelo caminho errado. *Exemplo:* peça "gere um endpoint FastAPI de health-check" e acompanhe o código aparecer no cartão.

- **Cartão de proposta + diff.** *Fundamento:* o código gerado não é aplicado direto; vira uma **proposta** com um diff (linhas `+`/`-`). *Benefício:* você revisa antes de tocar no seu projeto — nada muda sem seu aval. *Exemplo:* clique em **Ver diff** para inspecionar linha a linha antes de **Aplicar**.

- **Aplicar / Aplicar e abrir.** *Fundamento:* aplicar grava os arquivos propostos; "Aplicar e abrir" ainda abre o arquivo no editor. *Benefício:* do texto ao arquivo salvo em um clique, já posicionado para continuar. *Exemplo:* após gerar um módulo novo, **Aplicar e abrir** o deixa aberto para você editar.

- **Anexos por `@` (citar arquivos e pastas).** *Fundamento:* digite `@` e escolha um arquivo ou pasta — o conteúdo entra no contexto **e** o caminho aparece no seu prompt. Funciona também em **subdiretórios**, e o catálogo se atualiza ao vivo (arquivos recém-criados/movidos são descobertos). *Benefício:* você aponta exatamente o que a IA deve olhar, sem copiar/colar, com a citação legível no prompt. *Exemplo:* "explique `@src/core/Controller.ts` e sugira como quebrá-lo".

- **Segurança dos anexos.** *Fundamento:* antes de qualquer anexo sair para o modelo, segredos são **redigidos** e arquivos sensíveis (`.env`, chaves) são barrados. *Benefício:* citar um arquivo não vaza credencial. *Exemplo:* anexar um `config.py` com uma senha embutida envia `senha = "«oculto»"`.

- **OCR ao colar print.** *Fundamento:* cole (`Ctrl+V`) um **screenshot** (um traceback, um erro) e o FORGE extrai o **texto** da imagem via `tesseract`. *Benefício:* você joga o print do erro e não precisa digitar o traceback à mão. *Exemplo:* cole a foto de um `ORA-00942` e peça "corrija a causa". *(Requer o `tesseract` instalado — ver §13.)*

- **Reasoning effort / modelos.** *Fundamento:* dá para calibrar o esforço de raciocínio e o modelo por tarefa. *Benefício:* tarefas simples ficam rápidas e baratas; as difíceis ganham mais "pensamento". *Exemplo:* use um modelo leve (`gpt-oss-20b`) para um regex e o pesado (`120b`) para desenhar uma arquitetura.

- **Guarda de concorrência.** *Fundamento:* o FORGE impede duas gerações simultâneas se atropelarem. *Benefício:* sem respostas misturadas ou estado corrompido quando você dispara ações em sequência. *Exemplo:* iniciar uma revisão enquanto uma geração roda mostra "geração em andamento" em vez de embolar as duas.

---

## 4. A paleta de comandos — referência rápida

**Fundamento.** Digitando `/` no chat você abre uma **paleta de comandos** — atalhos determinísticos (a maioria roda **localmente**, sem gastar tokens de IA) para tarefas do dia a dia. Cada comando tem apelidos em pt/en/es. A tabela é o mapa; os detalhes de cada família estão nas seções indicadas.

| Comando | O que faz | Detalhe em |
|---|---|---|
| `/ajuda` | Lista os comandos disponíveis | esta seção |
| `/contexto` | Orçamento da janela de contexto (modelo, reservas, histórico, RAG) | §9 |
| `/tokens` | Uso de tokens da última geração e da sessão | §12 |
| `/limpar` | Zera a conversa (e o gasto acumulado da sessão) | §12 |
| `/ambiente` | Diagnostica e prepara o ambiente (deps, ferramentas) | §7 |
| `/notebook` | Prepara `.venv`, `ipykernel` e o seletor de kernel Jupyter | §5 |
| `/testes` | Roda a suíte de testes do projeto | §7 |
| `/perfil` | Abre/edita o perfil do projeto (`.forge/project.md`) | §10 |
| `/indice` | Visualiza o índice (skills ativas + trechos do RAG) | §9 |
| `/projeto` | **Modo Projeto**: gera um projeto inteiro a partir de um brief | §6 |
| `/revisar` | Revisão multi-lente do seu diff não-commitado | §13 |
| `/resumir` | Resume a conversa/arquivo | esta seção |
| `/diagrama` | Gera um diagrama (ex.: arquitetura, fluxo) | esta seção |
| `/sumário projeto` | Documentação funcional do projeto (proposta em `docs/SUMARIO_FUNCIONAL.md`) | esta seção |
| `/conexoes` | Lista as conexões de warehouse configuradas | §8 |
| `/executar-sql` | Roda o `.sql` ativo na conexão escolhida (governado) | §8 |
| `/schema-db` | Indexa o schema real do warehouse como grounding | §8 |
| `/impacto` | Raio de explosão (lineage) de um modelo dbt | §8 |
| `/paridade` | Compara duas tabelas por agregados (data-diff seguro) | §8 |
| `/custo` | Cockpit estimado de custo e hotspots da query ativa | §8 |
| `/auditoria-pii` | Mapeia colunas com potencial dado pessoal (LGPD) | §8 |
| `/testes-dbt` | Gera testes `schema.yml` de um modelo dbt | §8 |
| `/traduzir-sql` | Traduz SQL entre dialetos preservando semântica | §8 |
| `/sql-lab` | Abre o DuckDB local embutido e persistente | §8 |
| `/importar-schema` | Importa um DDL para o grounding local | §8 |
| `/validar-sql` | Valida segurança, schema e dialeto | §8 |
| `/plano-sql` | Cockpit estruturado de EXPLAIN/dry-run da consulta ativa | §8 |
| `/analisar-sql` | Métricas observadas com consentimento e auditoria | §8 |
| `/comparar-sql` | Compara os planos original e `.tuned.sql` | §8 |
| `/tunar-sql` | Otimiza usando evidências do plano, dialeto e schema | §8 |
| `/arquivos` | Lista arquivos do repo (só-leitura, governado) | §13 |
| `/buscar` | Busca por regex com defesa anti-ReDoS | §13 |
| `/todos` | Varre TODO/FIXME/HACK/XXX do código | §13 |
| `/git-status` · `/git-diff` · `/git-log` | Status, diff e histórico do git (só-leitura) | §13 |
| `/git-commit` | Commit governado, com confirmação | §13 |

> Comandos avulsos desta seção: **`/resumir`** condensa a conversa ou o arquivo ativo em pontos-chave; **`/diagrama`** desenha um diagrama (Mermaid) de arquitetura/fluxo a partir do código; **`/sumário projeto`** gera a documentação funcional do repositório (o que é, como roda, principais módulos), proposta em `docs/SUMARIO_FUNCIONAL.md`. Todos entram como proposta, revisável antes de aplicar.

---

## 5. Skills — o conhecimento especializado embutido

**Fundamento.** Uma **skill** é um pacote de conhecimento especializado (um arquivo `SKILL.md` com instruções, exemplos e validadores) que o FORGE **injeta no prompt quando é relevante**. Ele usa *progressive disclosure* (revelação progressiva): primeiro só o **nome + descrição** de cada skill entra no contexto (barato); quando o seu pedido casa com uma skill, o **corpo completo** dela é carregado. A ativação é **lexical** (por palavras do seu pedido) e/ou pela escolha estruturada no Modo Projeto.

**Benefício.** Você recebe código no padrão do especialista daquele domínio — pipelines idempotentes, notebooks bem estruturados, SQL dialeto-consciente — sem precisar dizer "lembre de tratar nulos, tipar, testar". A skill já carrega essas convenções e as **valida no gate** (ver §7).

**As 15 skills incluídas:**

| Skill | Domínio | Ative pedindo algo como… |
|---|---|---|
| `pandas-defensive-pipelines` | Pandas robusto (nulos, tipos, dedup) | "limpe este parquet com pandas" |
| `polars-pipelines` | Polars (alta performance) | "reescreva este ETL em polars" |
| `sql-dialect-aware` | SQL consciente de dialeto | "gere um SELECT para BigQuery" |
| `dbt-modeling` | Modelagem dbt (staging/marts/testes) | "crie um modelo dbt de pedidos" |
| `airflow-dags` | DAGs do Airflow | "monte uma DAG diária de ingestão" |
| `spark-pipelines` | Roteamento e otimização geral de PySpark | "faça um job Spark de agregação" |
| `spark-connect-notebooks` | Spark Connect, Spark SQL e DataFrames remotos | "crie um notebook Spark Connect sem JVM local" |
| `spark-classic-rdd` | Spark clássico avançado com SQL, DataFrames e RDD | "use pair RDD e particionador customizado" |
| `pytorch-training` | Treino em PyTorch | "escreva o loop de treino desta rede" |
| `mlops-pipelines` | MLOps (empacote, sirva, monitore) | "empacote este modelo para produção" |
| `data-quality-checks` | Qualidade de dados | "adicione checagens de qualidade" |
| `eda-notebooks` | Análise exploratória em notebooks | "faça uma EDA deste dataset" |
| `hexagonal-backend` | Backend Python em arquitetura hexagonal | "gere um serviço com portas/adaptadores" |
| `frontend-html-a11y` | Front-end HTML acessível | "crie um formulário de login acessível" |
| `claro-dashboard-ui` | Dashboards no padrão visual Claro | "crie um dashboard usando @data/vendas.csv" |

- **Toggle de skills.** *Fundamento:* você pode ligar/desligar skills. *Benefício:* silencia uma skill que não quer no momento. *Exemplo:* desligar `eda-notebooks` numa base que já passou da fase exploratória.

- **Skills gerenciadas pelo admin.** *Fundamento:* o admin pode apontar um diretório de skills da organização (`forge.skills.managedDir`). *Benefício:* a empresa distribui convenções próprias para todos. *Exemplo:* uma skill interna "padrão-claro-etl" chega a todo dev automaticamente.

- **Reindexar skills.** *Fundamento:* o comando **FORGE: Reindexar skills** reconstrói o catálogo. *Benefício:* após editar/adicionar uma skill, ela passa a valer sem reiniciar. *Exemplo:* rode-o depois de criar um novo `SKILL.md`.

> Quer escrever suas próprias skills? Veja [`skills/README.md`](skills/README.md).

---

## 6. Modo Projeto — gerar um projeto inteiro que roda

**Fundamento.** Além de gerar um trecho, o FORGE gera um **projeto completo** a partir de um *brief* (um formulário: o que construir, linguagem, arquitetura). Ele monta um **blueprint** (o plano de arquivos), gera cada arquivo ancorado nesse plano, e — o ponto central — **verifica que o projeto roda**: passa pelo quality gate, e um laço de **auto-reparo** conserta o que não compilar/passar antes de te entregar.

**Benefício.** Você sai de "quero um serviço hexagonal em Python com testes" para um repositório que **compila, tem estrutura coerente e passa nos testes**, sem montar o esqueleto à mão nem caçar imports quebrados.

**Exemplo.** Rode `/projeto` (ou o comando **FORGE: Novo projeto**). No formulário, escolha *backend Python · arquitetura hexagonal*. O FORGE ativa a skill `hexagonal-backend`, gera `domain/`, `ports/`, `adapters/`, `tests/`, roda o gate, e se o `mypy` reclamar de um tipo, ele mesmo corrige e revalida antes de propor.

- **Blueprint ancorado.** Cada arquivo é gerado sabendo dos contratos (assinaturas) dos arquivos já emitidos — evita que o `main.py` chame uma função que o `service.py` não expôs.
- **Auto-reparo com orçamento.** O laço de conserto respeita um teto de contexto para não estourar a janela do modelo; a continuação "clean-room" recebe os contratos já emitidos, evitando divergência.
- **TDD opcional.** O projeto pode nascer com testes primeiro, e o gate roda a suíte gerada.

---

## 7. Quality gates — o código já nasce revisado

**Fundamento.** Um **gate** é um portão de qualidade: antes de você poder **Aplicar**, o FORGE roda verificadores **locais** sobre o código gerado. Se um verificador **bloqueante** reprova, o *Aplicar* fica travado (você ainda pode forçar conscientemente, o que fica na auditoria). É a materialização do pilar "o código nasce revisado".

**Benefício.** Você quase nunca aplica código que não compila, quebra tipos, viola a arquitetura ou tem falha de segurança óbvia — o erro é pego **antes** de entrar no projeto, não no CI horas depois.

**Os verificadores:**

- **Compilação/tipos.** Python (`compileall`, `mypy`), TypeScript/JavaScript (`tsc`, inclusive `.mjs/.cjs/.mts/.cts`), Go (`gofmt`, `go build`), Java (checagem de camadas). *Exemplo:* um `import` inexistente no código gerado reprova o gate com a mensagem do compilador.
- **SAST (análise de segurança estática).** Regras equivalentes ao `bandit` (Python) e um motor puro-TS, procurando padrões perigosos (`eval`, injeção, segredo hard-coded). Regras **bloqueantes** sempre rodam por arquivo. *Exemplo:* um `eval(entrada_do_usuario)` gerado reprova.
- **Linters/formatadores.** `ruff` (Python) e afins, conforme a stack detectada. *Exemplo:* imports não usados viram reprovação de estilo.
- **Definition of Done (DoD) e convenções-como-validators.** A skill ativa e a stack do projeto anexam regras (ex.: "toda função pública tem type hint"). *Exemplo:* a skill `pandas-defensive-pipelines` exige tratamento de nulos.
- **Smoke test.** O gate **executa** a suíte de testes gerada (vitest/jest/pytest) como sinal (advisory). *Exemplo:* um teste que falha aparece no cartão, sem necessariamente travar o apply.
- **Acessibilidade (a11y).** Para HTML, checa práticas de acessibilidade. *Exemplo:* um `<input>` sem `<label>` é sinalizado.

- **`/ambiente`** — *Fundamento:* diagnostica e **prepara** o ambiente (detecta gerenciador de pacotes, instala/organiza dependências, aponta ferramentas ausentes). *Benefício:* "não roda na minha máquina" vira um comando. *Exemplo:* `/ambiente` num projeto novo detecta `uv`, cria o venv e reporta o que falta.
- **`/testes`** — *Fundamento:* roda a suíte do projeto e traz o resultado ao chat. *Benefício:* fechar o loop escrever→testar sem trocar de janela. *Exemplo:* `/testes` após aplicar uma correção mostra verde/vermelho por teste.

> O gate client-side é reforçado pelo **gate de CI** (ver §13) — o mesmo espírito, agora no pipeline.

---

## 8. Motor de dados — SQL, warehouse e dbt

Este é o coração para times de dados. O FORGE conecta-se a warehouses, **ancora a IA no seu schema real** e roda SQL com uma rede de segurança determinística.

### 8.1 Conexões e governança de execução

- **`/sql-lab`** — abre um DuckDB embutido e persistente em `.forge/sql/lab.duckdb`, sem instalar
  executável, Docker ou servidor. O arquivo `.forge/sql/lab.sql` vira a bancada local. Leituras rodam
  diretamente; escritas pedem confirmação; `DROP` e `TRUNCATE` continuam bloqueados.

- **`/conexoes`** — *Fundamento:* lista as conexões de warehouse configuradas (`forge.warehouse.connections`). *Benefício:* você vê e escolhe onde rodar sem decorar IDs. *Exemplo:* `/conexoes` mostra `dw (readonly)`, `legado`, `bq`.

- **Governança de execução por motor.** *Fundamento — o coração da segurança de dados:* quem decide se um SQL pode rodar **não é a IA nem um prompt**, é um **classificador determinístico** do próprio SQL. Regra: **leitura** (`SELECT`) roda automático; **escrita** (`INSERT`/`UPDATE`/`DELETE`/`MERGE`, e `SELECT … INTO`) só roda numa conexão marcada `readonly:false` **e** com confirmação num modal; **`DROP`/`TRUNCATE` são sempre bloqueados**. Funções voláteis (`setval`, `dblink`…) contam como escrita. *Benefício:* a IA (e você) podem sugerir e rodar SQL com a **garantia estrutural** de que nada destrói dados por acidente e de que uma conexão "somente-leitura" é realmente somente-leitura. *Exemplo:* numa conexão readonly, rodar um `.sql` com `DELETE FROM clientes …` devolve "⛔ A conexão é somente-leitura e a consulta contém escrita (DELETE)".

- **`/executar-sql [conexão]`** *(apelidos `/run-sql`, `/rodar-sql`)* — *Fundamento:* roda o `.sql` aberto (ou o trecho selecionado) na conexão escolhida, respeitando a governança acima; devolve uma **amostra** do resultado (limitada por `rowCap` e **mascarada** — ver §8.3). *Benefício:* fecha o loop escrever→rodar→corrigir sem sair do VS Code nem colar credencial, com o erro já pronto para a IA depurar. *Exemplo:* abra `vendas.sql`, digite `/executar-sql dw` → cartão "✅ sql · 0.4s" com as linhas mascaradas; se der `ORA-00942`, o erro vira anexo e você só pergunta "corrija".

### 8.2 Grounding: a IA conhece o seu schema

- **`/importar-schema [@arquivo]`** — extrai localmente tabelas, colunas, PKs, FKs, índices e comentários
  de um DDL, sem executá-lo. O catálogo versionável `.forge/sql/catalog.json` é combinado com dbt e
  snapshots de warehouse no grounding, na validação semântica e no tuning.

- **`/schema-db [conexão]`** *(apelido `/schema-warehouse`)* — *Fundamento:* tira um **snapshot** do schema **real** do warehouse vivo (só metadados — tabela, coluna, tipo; **nenhuma linha de dado**) e o injeta como **grounding**. *Benefício:* a IA para de inventar colunas — passa a gerar SQL com os nomes exatos do seu Oracle/Postgres/BigQuery, e o FORGE **bloqueia** proposta que referencie coluna inexistente. *Exemplo:* `/schema-db dw` → "Schema indexado: 128 tabelas, 1.4k colunas"; depois, "gere um SELECT de pedidos por mês" usa as tabelas reais.

- **Grounding dbt via manifest.** *Fundamento:* o `dbt` gera um `manifest.json` (o "mapa" do projeto: modelos, sources, colunas, dependências). O FORGE o lê automaticamente. *Benefício:* em qualquer projeto dbt, a IA conhece suas tabelas/colunas reais e sugere correções de digitação — e o grounding se atualiza sozinho a cada `dbt compile`. *Exemplo:* após `dbt compile`, pedir SQL no chat já usa os modelos reais; escrever `stg_ordrs` aciona o alerta "modelo `stg_ordrs` não existe — você quis dizer `stg_orders`?".

### 8.3 Ferramentas de dados (governadas)

- **`/validar-sql [conexão]`**, **`/plano-sql [conexão]`** e **`/tunar-sql [conexão]`** — formam o
  ciclo profissional de consulta: validação determinística de segurança, anti-padrões, schema e dialeto;
  cockpit de `EXPLAIN`/dry-run no motor selecionado; e uma proposta `.tuned.sql` ancorada em evidências
  estruturadas. O cockpit extrai custo, cardinalidade, bytes, buffers e operadores quando o banco os fornece,
  destaca scans, joins cartesianos, spill, partições e erros de cardinalidade e preserva o hash do plano.
  O DuckDB serve como laboratório local, mas o banco de destino continua autoritativo para tuning.

- **`/analisar-sql [conexão]`** — obtém evidência **observada**. PostgreSQL e DuckDB usam
  `EXPLAIN ANALYZE`, portanto executam a leitura; Oracle e BigQuery consultam o último cursor/job equivalente,
  sem repetir a query. Sempre exige confirmação explícita e gera decisão de auditoria. Use depois da estimativa,
  em ambiente e horário adequados.

- **`/comparar-sql [conexão]`** — com um arquivo `consulta.tuned.sql` ativo, localiza `consulta.sql`, obtém
  os dois planos estimados e mostra deltas de custo/bytes/buffers, hotspots resolvidos e introduzidos. A
  comparação de planos não afirma equivalência semântica nem ganho real: valide resultados e use
  `/analisar-sql` para confirmar desempenho observado.

- **`/impacto [modelo]`** *(apelidos `/impact`, `/blast`)* — *Fundamento:* mostra o **raio de explosão** de mexer num modelo dbt: tudo que depende dele a jusante (downstream — modelos, testes, exposures), mais as origens diretas a montante (upstream). *Benefício:* antes de alterar, você sabe exatamente quantos modelos/testes/dashboards quebram e de onde cada coluna vem — decisão baseada em dados, não em fé. *Exemplo:* `/impacto stg_orders` → "Downstream direto: 4 · Transitivo: 17 nós (prof. 3) · Testes: 9 · Exposures: painel_vendas · Upstream: raw.orders".

- **`/paridade tab_a tab_b`** *(apelidos `/parity`, `/data-diff`)* — *Fundamento:* compara duas tabelas por **agregados** (contagens, não-nulos, distintos) — um data-diff **compliance-safe**: nenhuma linha sai do banco, só estatísticas. *Benefício:* valida migração/reprocessamento ("as duas tabelas batem?") sem nunca extrair uma linha sensível, atendendo LGPD por construção. *Exemplo:* `/paridade legado:clientes novo:clientes` → "Iguais em 37 métricas ✅" ou uma tabela apontando `distintos.cpf: 10.000 vs 9.998`.

- **`/custo [conexão]`** *(apelidos `/cost`, `/finops`)* — *Fundamento:* dois modos FinOps. Com um `.sql`
  **ativo**, abre o cockpit estimado antes de rodar (dry-run no BigQuery = bytes processados; `EXPLAIN` nos
  demais). Sem arquivo, mostra as consultas/usuários que mais consomem na semana. *Benefício:* você evita
  scans desnecessários e enxerga onde o consumo se concentra. O FORGE não converte bytes ou custo do
  otimizador em moeda sem uma tabela de preços autoritativa. *(Este `/custo` é da query de dados; para tokens
  de IA use `/tokens`, §12.)*

- **`/auditoria-pii`** *(apelidos `/pii`, `/lgpd`)* — *Fundamento:* varre o schema **já indexado** (dbt + snapshots) procurando colunas com provável **dado pessoal**, pelo **nome** da coluna, contra um dicionário LGPD. 100% local, não lê valores. *Benefício:* mapa instantâneo de onde mora o dado pessoal no seu warehouse, para mascaramento, governança e resposta a auditoria — sem contratar ferramenta externa. *Exemplo:* após `/schema-db dw`, rode `/auditoria-pii` → "12 colunas com potencial PII em 128 tabelas" + tabela `clientes.cpf → documento (alta)`.

- **`/testes-dbt [modelo]`** *(apelidos `/dbt-tests`, `/testes-modelo`)* — *Fundamento:* gera (ou estende) o `schema.yml` de testes de um modelo dbt usando as colunas **reais** do manifest — nunca inventando nomes. *Benefício:* cobertura de testes de qualidade em segundos, ancorada nas colunas verdadeiras. *Exemplo:* com `fct_orders.sql` aberto, `/testes-dbt` propõe `order_id → unique+not_null`, `customer_id → relationships to ref('dim_customers')`.

- **`/traduzir-sql <dialeto>`** *(apelidos `/translate-sql`, `/traduzir`)* — *Fundamento:* traduz o SQL do arquivo ativo para outro **dialeto** (BigQuery, Snowflake, Postgres, Spark, Oracle…), preservando a semântica e marcando os pontos duvidosos. *Benefício:* portar consultas entre bancos (migração, POC multi-cloud) sem reescrever à mão nem mudar o resultado silenciosamente. *Exemplo:* com um `relatorio.sql` em Oracle, `/traduzir-sql bigquery` → `relatorio.bigquery.sql` (original intacto) com `NVL→IFNULL` e bullets do que mudou, mais eventuais `-- REVISAR:`.

### 8.4 Máscara LGPD de amostras

- **Máscara + rowCap.** *Fundamento:* toda amostra de dados que vai ao chat é **limitada em linhas** (`rowCap`) **e mascarada**: valores com cara de dado pessoal (CPF/CNPJ, e-mail, telefone BR, cartão) viram `▇▇▇`. *Benefício:* você usa dados reais para depurar, mas CPF/e-mail/cartão nunca aparecem crus no chat nem viram parte do prompt — LGPD por construção. *Exemplo:* um `SELECT nome,email,cpf` retorna no cartão `João, ▇▇▇, ▇▇▇`, só as primeiras `rowCap` linhas.

> **Importante (o que você precisa ter):** o SQL Lab já inclui o DuckDB no VSIX Windows x64. Bancos
> externos continuam usando o CLI correspondente no PATH ou MCP (Oracle: SQLcl; BigQuery: `gcloud`/`bq`;
> Postgres: `psql`…). A autenticação é do CLI, não da extensão. Em workspace não-confiável, execução e
> importação local ficam bloqueadas. Veja o [guia e roadmap do SQL Lab](docs/SQL-LAB-E-ROADMAP.md).

---

## 9. RAG — o FORGE conhece o SEU código

**Fundamento.** **RAG** (Retrieval-Augmented Generation) significa: em vez de responder só com o que o modelo "sabe", o FORGE primeiro **recupera** os trechos mais relevantes do **seu** código e os injeta no contexto. Assim, o código gerado usa os nomes, padrões e assinaturas que **já existem** no seu projeto.

**Benefício.** Menos alucinação e menos retrabalho: a IA chama a função que existe, com a assinatura certa, no estilo do projeto.

- **Liga/desliga (`forge.rag.enabled`, padrão ligado).** *Exemplo:* `"forge.rag.enabled": false` gera apenas com o arquivo aberto como contexto — útil em repositório enorme onde você quer velocidade máxima.

- **Chunking por fronteira lógica.** *Fundamento:* o código é quebrado em "pedaços" (chunks) nas **fronteiras lógicas** (início de função, classe, célula de notebook), não a cada N linhas cegas. *Benefício:* o trecho recuperado é "a função inteira", não meia-função cortada. *Exemplo:* um `etl.py` com 3 funções vira ~3 chunks, cada um começando em `def …`.

- **Embeddings in-network (Qwen3) + busca semântica.** *Fundamento:* um **embedding** transforma texto num vetor que representa o **significado**; textos parecidos ficam com vetores próximos, então "buscar por significado" vira "achar os vetores próximos". *Benefício:* busca semântica de verdade — você pergunta "onde tratamos autenticação de token?" e ele acha o código certo mesmo sem a palavra "token" aparecer. *Exemplo:* `"forge.rag.embeddings.url": "https://hub-gpus.claro.com.br/embed06b/v1"`, modelo `Qwen/Qwen3-Embedding-0.6B`.

- **Degradação para BM25 lexical (offline).** *Fundamento:* **BM25** é busca clássica por **palavras**. Sem rede/endpoint, o FORGE usa BM25. *Benefício:* o RAG **nunca** fica totalmente indisponível — sem internet você ainda recebe trechos relevantes. *Exemplo:* `"forge.rag.embeddings.url": ""` força o modo lexical; o cabeçalho dos trechos diz "(lexical, top N)".

- **Redação de segredos nos chunks e na query.** *Fundamento:* antes de qualquer trecho sair para o endpoint de embeddings ou ser gravado no cache em disco, segredos são apagados. *Benefício:* seu código é indexado com tranquilidade — nenhuma credencial vaza. *Exemplo:* `DB_PASSWORD = "p@ss"` é indexado como `DB_PASSWORD = "[REDACTED]"`.

- **Reindex incremental por watcher + snapshot.** *Fundamento:* ao salvar/criar/apagar um arquivo, só **aquele** é reprocessado; o índice é persistido em disco. *Benefício:* o contexto reflete o código atual sem esforço, e reabrir o projeto é rápido (não re-chama o hub). *Exemplo:* salvar `service.py` com uma função nova a inclui em segundos.

- **`/indice` — visualizador de contexto.** *Fundamento:* abre um painel só-leitura mostrando exatamente o que o FORGE injeta: skills ativas **e** trechos do RAG. *Benefício:* transparência total — você entende **por que** ele respondeu de certo jeito e confere a cobertura. *Exemplo:* `/indice` lista "`src/etl.py` — python — 4 trechos".

- **`/contexto`.** *Fundamento:* mostra um resumo do que compõe o contexto atual (skills, RAG, anexos, perfil). *Benefício:* diagnóstico rápido antes de uma geração cara.

- **Controles finos.** `forge.rag.maxChunks` (quantos trechos entram por geração), `forge.rag.maxFileSizeKb` (ignora arquivos gigantes), `forge.rag.include`/`exclude` (globs do que indexar), e um **teto de segurança** interno de 4000 chunks com aviso de truncamento. **FORGE: Reindexar codebase** reconstrói o índice do zero (obrigatório após mudar `dimensions`/modelo).

> A URL de embeddings deve terminar em `/v1` (o sufixo `/embeddings` é adicionado pelo cliente). URL vazia **não desliga** o RAG — apenas força o BM25; para desligar tudo use `forge.rag.enabled:false`. Só arquivos locais (`file`) são indexados; notebooks têm só as células de **código**.

---

## 10. Perfil do projeto — papel, regras e stack

**Fundamento.** O **perfil** (`.forge/project.md`, versionado no repo) captura o que o código não revela: seu **papel**, bibliotecas preferidas e as **convenções do time**. Ele é injetado no prompt a cada geração.

**Benefício.** Correções viram **duráveis**: "sempre use type hints", "prefira polars a pandas", "sem emojis na saída" passam a valer em toda sessão e para todo o time, em vez de você repetir a cada conversa.

- **`/perfil`** *(comando `forge.openProfile`)* — abre (e cria, se não existir) o `.forge/project.md`. *Exemplo:* `/perfil` semeia um esqueleto e abre no editor.

- **Papel do desenvolvedor** *(comando `forge.pickRole`)* — *Fundamento:* uma etiqueta da sua função que inclina o estilo e os defaults da IA. Cinco papéis: Cientista de dados, Engenheiro de dados, Engenheiro de ML, Engenheiro de IA, Engenheiro de software. *Benefício:* a saída combina com o **seu** jeito de trabalhar — um cientista de dados recebe código exploratório notebook-first; um engenheiro de dados recebe pipelines idempotentes e schema-explícitos. *Exemplo:* escolha "Engenheiro de dados" → o FORGE grava `papel: engenheiro-de-dados` no frontmatter.

- **Regras do time + "Promover correção a regra".** *Fundamento:* quando sua última mensagem soa como uma diretriz, o FORGE oferece salvá-la como regra permanente com um clique. *Benefício:* conhecimento do time **acumula** — o "nunca faça commit de `.env`" que você digitou uma vez fica valendo para todos. *Exemplo:* digite "sempre valide entradas com pydantic v2" → clique em "Salvar como regra".

- **Stack auto-detectada.** *Fundamento:* o FORGE lê os arquivos-âncora do repo (`pyproject.toml`, `requirements`…) a cada rodada para descobrir linguagem, gerenciador de pacotes, linter, type checker, framework de testes e libs — sem config manual. *Benefício:* acurácia zero-setup: o código gerado mira o `ruff`/`mypy`/`pytest` e as libs que você **realmente** usa, mesmo quando mudam. *Exemplo:* o painel Perfil mostra "Python · uv · ruff · mypy · pytest · pandas, duckdb".

- **Perfil gerido pelo admin + precedência.** *Fundamento:* o admin pode apontar um perfil da organização (`forge.project.managedProfile`), sob o pessoal e o do workspace. *Benefício:* governança central sem lock-in — baselines de segurança/estilo chegam a todos, mas um projeto ainda sobrepõe localmente. Precedência: admin → usuário → workspace.

---

## 11. Segurança e privacidade

O FORGE trata o seu código e os seus dados como soberanos. Estas são as defesas, do mais externo ao mais interno.

- **Egress deny-by-default.** *Fundamento:* um **firewall de saída** dentro da extensão. Todo destino de rede (provedor de IA, gateway, Langfuse, MCP, embeddings) é checado contra uma allowlist; o que não estiver listado é **recusado**. *Benefício:* impede exfiltração e SSRF — um setting mal configurado apontando os embeddings para um host arbitrário é barrado. *Exemplo:* por padrão, `https://api.openai.com` é **bloqueado** (`EgressBlockedError`) até você adicionar o host a `forge.egress.allowedHosts`.

- **SecretStorage — segredos nunca em settings/logs.** *Fundamento:* toda credencial (token de sessão, licença, chave de API, secret do Langfuse, credenciais MCP) vai para o **cofre criptografado do SO** e só lá. *Benefício:* suas chaves não vazam por um `settings.json` commitado ou um log exportado. *Exemplo:* após `forge.setupProvider`, inspecionar o `settings.json` ou o log não mostra rastro da chave.

- **Redação unificada de segredos e PII no egresso.** *Fundamento:* um **único** motor de limpeza mascara segredos e dados pessoais de qualquer texto que possa deixar a máquina (contexto RAG, arquivo ativo, anexos `@`, traces). *Benefício:* uma chave AWS ou um CPF esquecido num comentário não viaja ao gateway nem para um trace. *Exemplo:* `AWS_SECRET_ACCESS_KEY=…` e um CPF viram `«oculto»` no contexto enviado ao modelo.

- **Máscara PII / LGPD.** *Fundamento:* proteção em duas partes para dado pessoal brasileiro: (a) a **auditoria** de schema sinaliza colunas cujo **nome** parece pessoal; (b) o **mascaramento** de valores esconde CPF/e-mail/telefone em amostras. *Benefício:* você perfila e pré-visualiza dados de produção sem CPFs na tela, em anexo ou em trace. *Exemplo:* ver §8.3/§8.4.

- **Contenção de caminho + denylist de arquivos sensíveis.** *Fundamento:* como os caminhos das propostas vêm 100% do modelo, um guarda mantém arquivos gerados e leituras de contexto **dentro** do workspace e longe de arquivos de credencial. *Benefício:* um caminho proposto pela IA não escapa do repo para sobrescrever arquivos de sistema, e seu `.env`/chave privada nunca é sugado para o contexto. *Exemplo:* um bloco com `path='../../.ssh/authorized_keys'` é rejeitado e nunca escrito.

- **Licença Ed25519 offline.** Ver §2.2 — verificação criptográfica sem internet, com revogação via gateway.

- **Sair / limpar credenciais** *(comando `forge.signOut`)* — *Fundamento:* remove token, licença e chave de API do cofre e limpa a identidade em cache. *Benefício:* handoff limpo de uma máquina compartilhada. *Exemplo:* **FORGE: Sair** deixa o painel no estado não-licenciado.

- **Operação offline + diagnóstico redigido.** *Fundamento:* a extensão roda desconectada da internet pública; a **telemetria é desligada por padrão**; o único registro local é um **diagnóstico redigido** que você pode exportar. *Benefício:* zero tráfego-surpresa num ambiente fechado, e você entrega um bundle de bug ao suporte sabendo que segredos e PII já estão limpos. *Exemplo:* **FORGE: Exportar diagnóstico** gera um bundle com `«oculto»` no lugar de qualquer segredo/CPF.

> **Nuances de segurança que valem saber:** o modo de licença **local** é um **dissuasor**, não controle autoritativo — o controle real é o **gateway** (recusa inferência sem licença válida). A **redação** é defesa-em-profundidade no egresso, **não** uma fronteira de segurança (tira segredo, não código estrutural). A **chave privada** Ed25519 nunca sai do admin; a `secretKey` do Langfuse vive **apenas no gateway**. Segredos exigem um keychain do SO (num Linux sem secret service, o armazenamento pode falhar).

---

## 12. FinOps e observabilidade

**Fundamento.** **FinOps** é gestão do custo de computação; **observabilidade** é o registro detalhado do que o FORGE fez em cada geração (qual prompt, quanto demorou, se passou no gate) para você depois investigar. Ambos são opcionais e configuráveis por privacidade.

- **`/tokens`** — *Fundamento:* mostra quantos tokens (entrada/saída) a última geração usou e o acumulado da sessão. Token = a unidade em que modelos cobram (~4 caracteres). *Benefício:* feedback rápido de consumo sem abrir o Langfuse — útil para calibrar prompts grandes. *Exemplo:* `/tokens` → cartão "Última: 12k / 3.4k · Sessão: …".

- **`/limpar`** — zera a conversa **e** o gasto acumulado da sessão (corrige a antiga regressão do gasto não zerar).

- **Teto de gasto AUTORITATIVO (gateway, HTTP 402).** *Fundamento:* o limite **real e não-burlável** de tokens/dia, assinado na licença e imposto no gateway. *Benefício:* controle de custo à prova de adulteração — o dev não burla editando o cliente, e o estouro fica limitado a ~uma requisição em voo. *Exemplo:* ao estourar, a próxima geração falha com "(teto de tokens/dia da licença excedido — fale com o admin ou aguarde a virada do dia UTC; FinOps)".

- **Teto DETERRENTE da sessão (cliente, em R$/US$).** *Fundamento:* um aviso/bloqueio **local** em moeda do quanto a sessão já custou, complementar ao teto do gateway. *Benefício:* visibilidade imediata em reais e um freio suave contra queimar orçamento por engano. *Exemplo:* `"forge.observability.budget": 5, "forge.observability.currency": "R$"` → ao passar de R$4 (80%), notifica.

- **Modo de observabilidade** (`forge.observability.mode`: `off` | `direct` | `gateway`). *Fundamento:* onde os eventos vão. `off` = nada sai; `direct` = o cliente envia ao Langfuse; `gateway` = governança corporativa (a `secretKey` fica no gateway). *Benefício:* você escolhe o trade-off privacidade/governança sem tocar em código. *Exemplo:* `"forge.observability.mode": "gateway"`.

- **Modos de captura** (`langfuse.capture`: `full` | `masked` | `metadata-only`). *Fundamento:* quanto do conteúdo é registrado. `masked` (padrão) redige segredos/PII **e omite** o prompt/system do trace remoto; `metadata-only` grava só métricas; `full` é opt-in explícito do admin. *Benefício:* o padrão é LGPD-safe e não exfiltra seu código privado. *Exemplo:* `"…capture": "metadata-only"` registra modelo/tokens/durações, sem trechos.

- **Amostragem** (`langfuse.sampleRate`). *Fundamento:* fração das gerações efetivamente registradas (0–1). *Benefício:* controla volume/custo do Langfuse sem perder as **trilhas de auditoria de segurança** (escritas SQL, overrides de gate), que **nunca** são amostradas. *Exemplo:* `0.25` → ~25% viram trace; 100% das decisões de permissão continuam.

- **Diagnóstico local** (`forge.diagnostics.enabled`, padrão ligado). *Fundamento:* um registro NDJSON **sempre-ligado, sempre redigido e 100% local** de tudo que o FORGE faz. *Benefício:* histórico seguro para depurar "por que aquela geração falhou", independente de ter ligado o Langfuse. *Exemplo:* cada geração vira uma linha em `…/logs/forge-<sessão>.ndjson`.

- **Exportar diagnóstico** (`forge.exportDiagnostics`). *Fundamento:* gera um markdown legível e redigido (Ambiente / Resumo / Fases / Eventos) para anexar a um bug. *Benefício:* reportar bug com contexto completo em um clique, sem medo de vazar credencial. *Exemplo:* **FORGE: Export diagnostics (redacted bundle)**.

- **Fases cronometradas.** *Fundamento:* cada geração é dividida em fases medidas (assemble, rag, stream, continuation, gate, repair). *Benefício:* diagnóstico de lentidão baseado em dados — se "rag" domina, o gargalo é a busca de contexto, não o modelo. *Exemplo:* no bundle, "assemble: 400ms · stream: 8000ms…".

- **Trilha de auditoria de permissões.** *Fundamento:* toda decisão sensível (rodar MCP, escrita SQL, override do gate) vira evento auditável (quem, o quê, escopo, resultado). *Benefício:* auditoria pós-incidente respondida em segundos. *Exemplo:* um "Aplicar assim mesmo" sobre um gate reprovado aparece como `proposal.applied forced=true` (WARNING).

- **Setup do Langfuse** (`forge.setupObservability`). Guarda a `secretKey` (`sk-lf-…`) no cofre do VS Code, não num setting em texto plano.

> São **dois** tetos distintos: o do **gateway** é autoritativo em tokens/dia (HTTP 402, não-burlável); o do **cliente** é deterrente em R$/US$. O `/custo` (§8) é de **query SQL**, não de tokens de IA.

---

## 13. Utilitários — navegação, busca, git, MCP, OCR, CI/CD

- **`/arquivos [caminho]`** *(apelidos `/files`, `/ls`)* — *Fundamento:* lista os arquivos do repo no chat, como um `ls` seguro (só lê nomes; sensíveis são ocultados). *Benefício:* você enxerga a estrutura sem sair do chat e dá à IA um vocabulário de caminhos reais — determinístico e instantâneo. *Exemplo:* `/arquivos src/core` lista os arquivos sob `src/core/` (capado em 60, com "mais N").

- **`/buscar <regex>`** *(apelidos `/search`, `/grep`)* — *Fundamento:* procura um padrão em todos os arquivos, localmente, com **defesa anti-ReDoS** (recusa padrões perigosos). *Benefício:* um grep seguro no chat — acha usos de uma função sem risco de congelar o editor. *Exemplo:* `/buscar redactSecrets\(` agrupa as ocorrências por arquivo com linha; um padrão como `(a+)+` é recusado como inseguro.

- **`/todos`** *(apelidos `/todo`, `/fixme`)* — *Fundamento:* lista os marcadores TODO/FIXME/HACK/XXX. *Benefício:* inventário instantâneo da dívida técnica anotada, agrupado por arquivo. *Exemplo:* `/todos` antes de fechar uma tarefa.

- **Git no chat.** *Fundamento:* operações de git direto no painel. **`/git-status`** (branch, arquivos modificados, à frente/atrás), **`/git-diff`** (diff vs. HEAD), **`/git-log`** (últimos commits) são **só-leitura**; **`/git-commit "msg"`** **escreve** e por isso **exige confirmação** (lista os arquivos antes) e só pega arquivos **já rastreados**. *Benefício:* ver o estado e commitar sem trocar de janela, com nomes acentuados legíveis, dentro da auditoria. *Exemplo:* `/git-commit "fix: corrige orçamento de contexto"` → diálogo com os N arquivos → "Commitar" → cartão "✅". *(Escopo enxuto de propósito: `push`/`pull`/`reset`/`rebase` ficam de fora. Requer Workspace Trust.)*

- **`/revisar`** *(comando `forge.reviewChanges`)* — *Fundamento:* pede à IA uma revisão do seu diff **não-commitado** sob várias **lentes** (correção, segurança, dados/LGPD, performance, estilo). *Benefício:* pega bugs, riscos e vazamento de PII **antes** do commit/PR, encurtando o ciclo. *Exemplo:* faça mudanças, digite `/revisar`, receba os achados por severidade.

- **Catálogo MCP** (`forge.mcp.catalog`). *Fundamento:* **MCP** (Model Context Protocol) é um padrão aberto para dar à IA **ferramentas** extras (consultar um sistema interno, um banco, uma busca corporativa). O catálogo é a lista aprovada, com **aprovação por uso** e auditoria. *Benefício:* estende o que a IA faz com sistemas internos, mas você/o admin controla cada chamada. *Exemplo:* o admin adiciona um servidor `jira-interno` (transport `streamableHttp`, `scope: readonly`, `autoApprove: false`), intra-rede.

- **Busca interna via MCP — a "web" soberana** (`forge.search.server`/`tool`/`queryArg`). *Fundamento:* substitui a busca na internet pública por uma busca numa fonte **interna** aprovada. Por soberania de dados, o FORGE **não navega na internet pública**. *Benefício:* a IA ganha "buscar informação" sem abrir mão da soberania — texto e resultados ficam na rede. *Exemplo:* o botão "Buscar (rede interna)" consulta o servidor configurado.

- **OCR ao colar print** (`forge.ocr.tesseractPath`/`tessdataPath`). Ver §3 — extrai texto de screenshots via `tesseract` do **sistema** (não vem embutido no `.vsix`). *Exemplo:* config opcional para tesseract portable e depois `Ctrl+V` de um print de erro.

- **CI/CD: revisor de PR soberano** (`ci/forge-review.mjs`). *Fundamento:* um robô que revisa **Pull/Merge Requests** no pipeline, comentando como um revisor sênior (multi-lente), **in-network** (o código não sai da empresa) — o "CodeRabbit soberano". *Benefício:* todo PR ganha uma primeira revisão automática, com sugestões inline. *Exemplo:* no GitHub Actions, `node ci/forge-review.mjs` com `LLM_BASE_URL=https://hub-gpus.claro.com.br/gpt120/v1`. É **no-op** se `LLM_BASE_URL` não estiver definido (não quebra o pipeline). Há workflows prontos para GitHub Actions e GitLab CI.

---

## 14. Referência: configurações (settings)

O FORGE expõe **59** chaves `forge.*` em `settings.json` (muitas são **managed settings** do admin). As principais:

| Setting | Padrão | Descrição |
|---|---|---|
| `forge.gateway.url` | `""` | Gateway in-network (vazio = modo local) |
| `forge.license.mode` | `local` | `gateway` (autoritativo) ou `local` (dissuasor) |
| `forge.skills.managedDir` | `""` | Diretório de skills do admin (vazio = empacotadas) |
| `forge.skills.retrievalThreshold` / `topK` | `15` / `8` | Acima do limiar, discovery vira top-K por relevância |
| `forge.egress.allowExternal` | `false` | **Deny-by-default.** Não altere sem segurança |
| `forge.egress.allowedHosts` | `[hub-gpus.claro.com.br]` | Hosts in-network permitidos |
| `forge.egress.trustInNetwork` | `true` | Confia em loopback/LAN |
| `forge.mcp.catalog` | `[]` | Catálogo de MCP servers |
| `forge.validation.gateBlocksApply` | `true` | Gate reprovado bloqueia *Aplicar* |
| `forge.env.prepareOnRun` | `ask` | Em Run Python com `requirements.txt` e sem venv: `ask`, `always` ou `never` |
| `forge.warehouse.connections` | `[]` | Conexões de warehouse (SQL/dbt) |
| `forge.sqlLab.enabled` | `true` | Habilita o DuckDB local embutido |
| `forge.sqlLab.memoryLimit` / `.maxTempDirectorySize` / `.threads` | `1GB` / `2GB` / `2` | Limites do SQL Lab |
| `forge.sql.dialect` | `auto` | Dialeto para validação e tuning |
| `forge.rag.enabled` | `true` | Liga/desliga o RAG |
| `forge.rag.embeddings.url` / `.model` / `.dimensions` | — | Embeddings in-network (Qwen3) |
| `forge.rag.maxChunks` / `maxFileSizeKb` | `20` / — | Quantos trechos por geração / teto por arquivo |
| `forge.rag.include` / `exclude` | globs | O que o RAG indexa / ignora |
| `forge.project.managedProfile` | `""` | Perfil da organização (admin) |
| `forge.observability.mode` | `off` | `off` / `direct` / `gateway` |
| `forge.observability.langfuse.capture` | `masked` | `full` / `masked` / `metadata-only` |
| `forge.observability.budget` / `currency` / `pricing` | — | Teto deterrente da sessão (R$/US$) |
| `forge.diagnostics.enabled` | `true` | Log local NDJSON redigido (100% local) |
| `forge.telemetry.enabled` | `false` | Telemetria de produto (opt-in) |
| `forge.ocr.tesseractPath` / `tessdataPath` | — | OCR ao colar print (tesseract do sistema) |
| `forge.outputLanguage` | `pt-BR` | Idioma da saída (pt-BR / en / es) |

*(A lista completa está em `package.json` → `contributes.configuration` e no [Guia do Admin](docs/GUIA-DO-ADMIN.md).)*

---

## 15. Referência: comandos do VS Code

Além da paleta `/` do chat, há **19** comandos na paleta do VS Code (`Ctrl+Shift+P`, prefixo "FORGE:"):

| Comando | Função |
|---|---|
| FORGE: Focar painel · Abrir à direita · Nova tarefa | Abrir/posicionar o painel, iniciar tarefa |
| FORGE: Ativar licença | Colar a chave Ed25519 |
| FORGE: Configurar provedor | Endpoint + chave (vai ao cofre) |
| FORGE: Reindexar skills · Reindexar codebase | Reconstruir catálogos de skills / RAG |
| FORGE: Rodar arquivo ativo | Executar o arquivo aberto |
| FORGE: Revisar mudanças | Revisão multi-lente do diff (`/revisar`) |
| FORGE: Rodar testes | Suíte de testes do projeto (`/testes`) |
| FORGE: Sair | Limpar credenciais do cofre |
| FORGE: Mostrar saída · Exportar diagnóstico | Log / bundle redigido |
| FORGE: Configurar observabilidade | Guardar `secretKey` do Langfuse |
| FORGE: Definir saída máxima | Teto de tokens de saída |
| FORGE: Preparar ambiente | Criar `.venv` e instalar deps (`/ambiente`); o Run Python também oferece esse preparo |
| FORGE: Definir papel no projeto | Escolher o papel do dev |
| FORGE: Inspecionar índice | Abrir o visualizador do índice (`/indice`) |
| FORGE: Abrir Perfil do projeto | Editar `.forge/project.md` (`/perfil`) |

---

## 16. Mais documentação

- **Guia do Usuário** (passo a passo, para leigos): [`docs/GUIA-DO-USUARIO.md`](docs/GUIA-DO-USUARIO.md)
- **Guia do Admin** (licenças, gateway, skills, MCP, settings): [`docs/GUIA-DO-ADMIN.md`](docs/GUIA-DO-ADMIN.md)
- **Auditoria do Modo Projeto**: [`docs/auditoria-modo-projeto.md`](docs/auditoria-modo-projeto.md)
- **Autoria de skills**: [`skills/README.md`](skills/README.md)
- **Gateway e Langfuse**: [`gateway/README.md`](gateway/README.md)
- **Admin (licenças)**: [`admin-cli/README.md`](admin-cli/README.md)

---

<div align="center">

**FORGE — Codegen Claro** · v2.12.0 · publisher `claro-data-platform` · VS Code ≥ 1.93
Licença do produto: **Apache-2.0** ([LICENSE](LICENSE) · [NOTICE](NOTICE))

Implementação independente e limpa, inspirada no Cline (Apache-2.0) e no padrão aberto Agent Skills, sem usar marca/código "Cline".

</div>
