# 🛠️ Guia do Administrador — FORGE

> **Quem é o admin?** É a pessoa (ou equipe) responsável por **liberar e governar** o FORGE na
> organização: emitir as licenças, manter o catálogo de habilidades (skills), subir o servidor de
> validação (gateway), ligar a observabilidade e definir as regras de segurança. O usuário final
> (o "dev") só instala e usa — quem prepara o terreno é você.

Este guia é detalhado e explica cada conceito em linguagem simples. Você **não precisa** ser
especialista em criptografia ou DevOps — vamos passo a passo. Para a visão do usuário final, veja o
[Guia do Usuário](GUIA-DO-USUARIO.md).

---

## Índice
1. [O que você controla](#1-o-que-você-controla)
2. [Como tudo se encaixa (visão geral)](#2-como-tudo-se-encaixa-visão-geral)
3. [Preparar a máquina](#3-preparar-a-máquina)
4. [Passo 1 — Gerar as chaves de licença](#4-passo-1--gerar-as-chaves-de-licença)
5. [Passo 2 — Emitir licenças para os devs](#5-passo-2--emitir-licenças-para-os-devs)
6. [Passo 3 — Empacotar e distribuir a extensão](#6-passo-3--empacotar-e-distribuir-a-extensão)
7. [Passo 4 — Subir o gateway (validação + proxy)](#7-passo-4--subir-o-gateway-validação--proxy)
8. [Passo 5 — Ligar a observabilidade (Langfuse)](#8-passo-5--ligar-a-observabilidade-langfuse)
9. [Passo 6 — Curar o catálogo de Skills](#9-passo-6--curar-o-catálogo-de-skills)
10. [Passo 7 — Governar MCP e a rede (egress)](#10-passo-7--governar-mcp-e-a-rede-egress)
11. [Passo 8 — Configurar embeddings (busca semântica)](#11-passo-8--configurar-embeddings-busca-semântica)
12. [Distribuir configurações para todos](#12-distribuir-configurações-para-todos)
13. [Revogar e rotacionar chaves](#13-revogar-e-rotacionar-chaves)
14. [Checklist de produção](#14-checklist-de-produção)
15. [Solução de problemas](#15-solução-de-problemas)
16. [Segurança: o modelo de ameaça](#16-segurança-o-modelo-de-ameaça)
17. [Glossário para leigos](#17-glossário-para-leigos)

---

## 1. O que você controla

| Área | Você define |
|---|---|
| **Licenças** | quem pode usar, por quanto tempo, com qual escopo; pode revogar |
| **Skills** | o catálogo de boas práticas que o FORGE aplica |
| **Gateway** | o servidor que valida licença, intermedeia a IA e gera os registros |
| **Observabilidade** | o que é registrado (custo, latência, uso) no Langfuse |
| **MCP** | quais ferramentas internas o FORGE pode usar |
| **Rede (egress)** | quais endereços são permitidos (tudo interno por padrão) |
| **Distribuição** | empacotar e entregar a extensão aos devs |

---

## 2. Como tudo se encaixa (visão geral)

Em linguagem simples:

```
  [ Dev no VSCode ]                 [ Gateway (servidor) ]            [ Serviços internos ]
   - cola a licença   --(valida)-->  - confere a licença      ----->  - HubGPU (a IA)
   - descreve a tarefa               - repassa o pedido à IA          - Langfuse (registros)
   - recebe o código  <--(resposta)- - gera os registros de uso       - Oracle/DB via MCP
```

- A extensão guarda no cliente **apenas a chave pública** (que só serve para *conferir* a licença).
- A **chave privada** (que *cria* licenças) e a **secretKey do Langfuse** ficam **só com você / no
  servidor** — nunca na máquina do dev. Isso é o coração da segurança.
- Há **dois modos**:
  - **local** (sem gateway): a extensão valida a licença sozinha. Bom para piloto/testes.
  - **gateway** (produção): um servidor é a autoridade — recusa licenças inválidas/revogadas e
    intermedeia a IA. Recomendado.

---

## 3. Preparar a máquina

Você vai usar uma máquina de administração com:
- **Node.js 18 ou mais novo** (testado no 22). Confira com `node --version`.
- Acesso ao **código do FORGE** (este repositório).

No diretório do projeto, instale as dependências uma vez:
```bash
npm install
```

> 🔐 **Regra de ouro:** a pasta `admin-cli/keys/` (que vai guardar a chave privada) **nunca** deve
> ser versionada nem sair desta máquina. Ela já está protegida pelo `.gitignore`.

---

## 4. Passo 1 — Gerar as chaves de licença

O FORGE usa um par de chaves **Ed25519** (um padrão de assinatura digital):
- **chave privada** → *cria/assina* licenças (fica só com você);
- **chave pública** → *confere* licenças (vai embutida na extensão; é segura de distribuir).

Gere o par uma única vez:
```bash
npm run keygen
# ou, definindo um identificador de chave:
node admin-cli/forge-admin.mjs keygen --key-id ed25519-2026-01
```

O que isso faz:
- cria `admin-cli/keys/private.pem` (a **chave privada** — guarde com cuidado, faça backup seguro);
- cria `admin-cli/keys/keyinfo.json` (identificador + chave pública, usado pelo gateway);
- escreve a **chave pública** dentro do código da extensão (`src/license/embeddedKey.ts`).

> ⚠️ **Importante:** depois de gerar (ou trocar) a chave, você precisa **reconstruir e
> redistribuir** a extensão (Passo 3), para que os devs recebam a chave pública nova. Licenças
> assinadas com uma chave só validam contra a chave pública correspondente.

---

## 5. Passo 2 — Emitir licenças para os devs

Cada dev recebe uma **chave de licença** (texto `FORGE-...`). Para emitir:

```bash
npm run license:issue -- --subject joao@claro.com.br --org claro --scope codegen,skills --days 365
```

Parâmetros (todos opcionais, com padrões):
| Parâmetro | Significado | Padrão |
|---|---|---|
| `--subject` | identidade do dev (e-mail) | `dev@claro.com.br` |
| `--org` | organização | `claro` |
| `--scope` | o que a licença libera (`codegen`, `skills`) | `codegen,skills` |
| `--days` | validade em dias | `365` |

A saída é a chave `FORGE-...`. **Copie e envie ao dev** (por um canal seguro). Ele cola essa chave
no primeiro uso da extensão.

> 💡 A licença é **autoassinada e verificável offline**: a extensão confere a assinatura, a validade
> e o escopo sem precisar de internet. Em produção, o gateway confere de novo (autoritativo).

---

## 6. Passo 3 — Empacotar e distribuir a extensão

Gere o pacote instalável (`.vsix`):
```bash
npm run build      # compila a extensão e a interface
npm run package    # gera forge-<versão>.vsix (a versão vem do package.json)
```

Formas de distribuir:

**A) Entrega direta do `.vsix` (mais simples, recomendado para uso interno)**
Compartilhe o arquivo `forge-<versão>.vsix` (rede, repositório de artefatos, etc.). O dev instala pelo
*"Install from VSIX..."* (ver Guia do Usuário). Como é uso interno, normalmente **não** se publica
em lojas públicas.

**B) Publicar no Marketplace / Open VSX (opcional)**
Há automações prontas:
- **GitHub Actions** (`.github/workflows/release.yml`) — publica ao criar uma tag `v*`.
- **GitLab CI** (`.gitlab-ci.yml`) — estágio `publish` (manual).

Para isso, cadastre os segredos no repositório:
- `VSCE_PAT` — token do Azure DevOps (VS Marketplace);
- `OVSX_PAT` — token do Open VSX.

E garanta que exista um *publisher* (`claro-data-platform`) e o *namespace* correspondente.

> ℹ️ A cada `push`/PR, a CI (`ci.yml`) já roda testes + build + empacotamento e anexa o `.vsix` como
> artefato — útil para distribuição interna sem lojas públicas.

---

## 7. Passo 4 — Subir o gateway (validação + proxy)

O **gateway** é o servidor que, em produção, faz três coisas: (1) valida a licença de forma
autoritativa, (2) repassa os pedidos à IA (HubGPU) e (3) gera os registros de observabilidade. Ele
é o único lugar que guarda segredos sensíveis.

1. Copie o arquivo de exemplo e ajuste:
   ```bash
   cp gateway/.env.example gateway/.env
   ```
2. Edite `gateway/.env`. O mínimo é apontar para a IA interna:
   ```bash
   PORT=8787
   UPSTREAM_BASEURL=https://hub-gpus.claro.com.br/gpt120/v1
   # Se a IA exigir autenticação por header:
   UPSTREAM_AUTH_HEADER=Authorization: Bearer SEU_TOKEN
   ```
3. Suba o serviço:
   ```bash
   node gateway/server.mjs
   # → "gateway no ar" em http://localhost:8787
   ```
4. Aponte os devs para o gateway. Eles (ou você, via configuração distribuída) ajustam:
   ```jsonc
   "forge.license.mode": "gateway",
   "forge.gateway.url": "http://SEU-HOST-INTERNO:8787",
   "forge.egress.allowedHosts": ["SEU-HOST-INTERNO", "hub-gpus.claro.com.br"]
   ```

**Endpoints do gateway** (para diagnóstico):
| Rota | Função |
|---|---|
| `GET /health` | status: versão, uptime, sessões, fila de traces |
| `POST /license/activate` | valida a licença e devolve um token de sessão |
| `POST /license/renew` | renova a sessão |
| `POST /v1/chat/completions` | repassa a inferência (autenticado por token) |

**Recursos de produção já incluídos:** sessões com validade e limite, *rate limiting*, registros em
formato estruturado, encerramento gracioso e **TLS opcional** (defina `HTTPS_KEY` e `HTTPS_CERT`
no `.env`). Veja [gateway/README.md](../gateway/README.md) para todos os parâmetros.

> 🔒 Para produção, coloque o gateway atrás de TLS/mTLS na rede interna e use um armazenamento
> compartilhado de sessões se houver mais de uma instância.

---

## 8. Passo 5 — Ligar a observabilidade (Langfuse)

O **Langfuse** é uma ferramenta que registra cada geração (custo, tokens, latência, skills usadas).
Os registros são emitidos **pelo gateway** — assim a chave secreta nunca chega ao dev.

No `gateway/.env`:
```bash
LANGFUSE_ENABLED=true
LANGFUSE_BASEURL=https://langfuse.interno.claro.com.br
LANGFUSE_PUBLIC_KEY=pk-lf-xxxxxxxx
LANGFUSE_SECRET_KEY=sk-lf-xxxxxxxx          # ← SOMENTE no servidor. Nunca no cliente.
LANGFUSE_ENV=production
LANGFUSE_SAMPLE_RATE=1.0                    # 1.0 = registra tudo; 0.2 = registra 20%
LANGFUSE_CAPTURE=masked                     # full | masked | metadata-only
```

O que escolher em `LANGFUSE_CAPTURE` (política de conteúdo, importante para LGPD):
- **full** — registra prompt e resposta completos;
- **masked** — registra, mas **mascara** dados sensíveis (e-mails, tokens, números longos);
- **metadata-only** — registra só metadados (sem o conteúdo do código).

### Eventos de workflow do cliente — `forge.observability.mode`

A geração é rastreada pelo gateway (acima). Mas os eventos de **workflow** — proposta aplicada ou
descartada, quality gate, execução, revisão — acontecem **só no cliente** e nunca passam pelo proxy
de geração. O destino deles é governado pelo setting (distribua junto com as managed settings):

```jsonc
"forge.observability.mode": "gateway"   // off (padrão) | direct | gateway
```

- **off** (padrão) — nenhum evento de workflow sai da máquina do dev;
- **gateway** (recomendado em produção) — os eventos vão ao **gateway** (`POST /obs/ingest`,
  autenticado pela sessão da licença, com revogação e rate limit) e ele encaminha ao Langfuse com a
  `secretKey` **só no servidor**. O gateway **não confia no cliente**: re-aplica a SUA política de
  captura (`LANGFUSE_CAPTURE` prevalece), carimba a identidade da sessão e amostra por trace;
- **direct** — o cliente envia direto ao Langfuse com as chaves do próprio dev (uso pessoal/PoC — a
  `secretKey` vive no cliente; evite em produção).

> Retrocompat: o setting antigo `forge.observability.langfuse.enabled: true` sem `mode` definido
> equivale a `direct`.

**Custo por geração (FinOps).** Sem tabela de preços, **nenhum custo é emitido** — o FORGE não
fabrica números (o HubGPU é self-hosted; o custo interno é decisão sua). Para ver R$ por geração no
Langfuse, defina o preço **por 1 milhão de tokens** (a chave casa por substring do modelo; a mais
específica vence):

```jsonc
"forge.observability.pricing": {
  "gpt-oss-120b": { "input": 2.50, "output": 10.00 }
},
"forge.observability.currency": "R$"
```

**Identidade do dev (quem rodou cada geração).** A identidade principal é o **e-mail**, gravado como
**`userId`** do trace no Langfuse — assim você filtra o uso por pessoa. Como o e-mail é obtido:

- **Coleta automática:** se o `subject` da licença for um e-mail (caso de licença por usuário), ele é
  usado direto.
- **Coleta manual obrigatória:** se o `subject` **não** for um e-mail (genérico/compartilhado), ou se
  você ativar **`forge.identity.requireEmail: true`**, o dev é **obrigado a informar o e-mail no setup
  inicial** — sem isso a configuração não conclui e a geração fica bloqueada.

> 💡 Use `forge.identity.requireEmail: true` quando emitir **licenças compartilhadas** (um mesmo
> `subject` para vários devs) — assim cada pessoa informa o próprio e-mail e a atribuição no Langfuse
> fica individual.

O login do SO e o `subject`/hash da licença também vão nos metadados do trace. A captura da
**geração** acontece quando a inferência passa **pelo gateway** (provedor apontando para o gateway,
ou o gateway como proxy) — em acesso direto ao HubGPU não há trace de geração; os eventos de
**workflow** do cliente seguem o `forge.observability.mode` acima. Para conformidade (LGPD), trate o
e-mail como dado pessoal e ajuste a retenção no Langfuse conforme sua política.

> 🛡️ Se o Langfuse cair, o FORGE **não trava**: ele descarta/enfileira os registros e segue gerando
> ("fail-open"). A observabilidade nunca atrapalha o usuário.

---

## 9. Passo 6 — Curar o catálogo de Skills

**Skill** = um arquivo `SKILL.md` com instruções de boas práticas para um domínio. O FORGE injeta a
skill certa automaticamente quando a tarefa do dev casa com ela.

**Onde ficam:** na pasta `skills/` (empacotada com a extensão) ou numa pasta sua, apontada por
`forge.skills.managedDir`. O FORGE também lê `~/.forge/skills/`, `<projeto>/.forge/skills/` e
`<projeto>/.claude/skills/`.

**Estrutura de uma skill:**
```
minha-skill/
├── SKILL.md        ← obrigatório
├── scripts/        ← opcional (executáveis)
├── references/     ← opcional (lidos sob demanda)
└── assets/         ← opcional (modelos/dados)
```

**Cabeçalho do `SKILL.md`** (a parte entre `---`):
```yaml
---
name: minha-skill                 # só letras minúsculas, números e hífen; igual ao nome da pasta
description: >-                    # 1 a 1024 caracteres; diga O QUE faz E QUANDO usar (o "gatilho")
  Faz X e Y. Use whenever o usuário trabalha com Z.
license: Apache-2.0               # opcional
metadata: { author: claro, version: "1.0" }   # opcional
validators:                       # opcional — conferência de qualidade local
  - id: ruff
    label: ruff
    command: "ruff check {file}"  # {file} é substituído pelo arquivo gerado
    gate: true                    # true = reprovação BLOQUEIA o "Aplicar" do dev
    appliesTo: [".py", ".ipynb"]  # extensões alvo
---
# Corpo: quando usar, passo a passo, exemplos exatos, erros comuns
```

Dicas:
- A **`description` é o "gatilho"**: descreva bem *quando* usar, porque é por ela que o FORGE decide
  ativar a skill.
- **Validadores com `gate: true`** transformam a skill num **portão de qualidade**: o dev só aplica
  o código se passar (ex.: `ruff`/`mypy` sem erros). Sem `gate`, a checagem é só uma sugestão.
- **Versione as skills no Git** e tenha um processo de revisão — skills executam instruções e
  scripts, então o catálogo precisa ser confiável.

Já acompanham 10 skills de dados/IA (pandas, polars, SQL, dbt, Airflow, Spark, PyTorch, MLOps,
qualidade de dados, EDA). Veja [skills/README.md](../skills/README.md).

---

## 10. Passo 7 — Governar MCP e a rede (egress)

### Egress (saída para a internet) — bloqueado por padrão
Por segurança, o FORGE **nega qualquer conexão externa** a menos que você libere. Configure a lista
de endereços internos permitidos:
```jsonc
"forge.egress.allowExternal": false,                       // mantenha false em produção
"forge.egress.allowedHosts": ["hub-gpus.claro.com.br", "gateway.interno"],
"forge.egress.trustInNetwork": true                        // false = endurecido (ver abaixo)
```
Tudo que estiver fora dessa lista (e não for endereço de rede interna) é **bloqueado e registrado**.

Com **`forge.egress.trustInNetwork: false`**, endereços de rede interna (LAN, `.internal`, IP
privado) **deixam de ser liberados automaticamente** — só loopback (a própria máquina) passa sem
allowlist; todo o resto precisa estar em `allowedHosts`. Use em ambientes que exigem defesa contra
exfiltração/SSRF **dentro** da rede. O padrão `true` mantém o comportamento clássico.

### MCP (ferramentas internas governadas)
MCP permite que o FORGE use ferramentas da empresa (ex.: consultar o Oracle). Você define o
**catálogo** (apenas você — é uma "managed setting"):
```jsonc
"forge.mcp.catalog": [
  {
    "id": "oracle-sqlcl",
    "transport": "streamableHttp",        // ou "stdio" (processo local)
    "url": "https://oracle-mcp.interno/mcp",   // só endereços INTERNOS são aceitos
    "scope": "readonly",                  // readonly | readwrite
    "autoApprove": false,                 // false = pede aprovação do dev a cada uso
    "credentialRef": "oracle-mcp",        // referência a um segredo (nunca o valor)
    "enabled": true
  }
]
```
Regras aplicadas automaticamente:
- **Apenas endereços internos** são conectáveis (egress externo é negado).
- Cada chamada de ferramenta **pede aprovação** do dev (a menos que você marque `autoApprove` para
  escopo somente-leitura).
- Toda chamada é **auditada** (registrada).
- Credenciais vêm do **cofre** (SecretStorage/gateway), nunca embutidas na extensão.

---

## 10.1. Busca interna (o equivalente soberano à "web")

O FORGE **não navega na internet pública** por design. Para dar ao dev uma "busca", você expõe uma
**fonte interna** (wiki, Confluence, docs, base de conhecimento) como **MCP** e a aponta:

```jsonc
// 1) cadastre o MCP de busca no catálogo (ver Passo 7)
"forge.mcp.catalog": [
  { "id": "wiki", "transport": "streamableHttp", "url": "https://wiki-mcp.interno/mcp", "scope": "readonly", "autoApprove": true, "enabled": true }
],
// 2) aponte a busca para ele
"forge.search.server": "wiki",     // id do MCP acima
"forge.search.tool": "search",     // nome da ferramenta de busca exposta
"forge.search.queryArg": "query"   // nome do argumento do texto buscado
```

Com isso, o menu **📎 → Buscar (rede interna)** fica habilitado: o dev digita a busca, o FORGE chama
a ferramenta MCP (com **egress/aprovação/auditoria**) e anexa os resultados ao contexto. Tudo
in-network. Sem configurar, o item aparece como **bloqueado** (transparente ao usuário).

## 11. Passo 8 — Configurar embeddings (busca semântica)

A "busca inteligente" no código do dev usa um modelo de **embeddings**. O padrão já aponta para o
modelo interno da Claro:
```jsonc
"forge.rag.embeddings.url": "https://hub-gpus.claro.com.br/embed06b/v1", // NÃO inclua /embeddings
"forge.rag.embeddings.model": "Qwen/Qwen3-Embedding-0.6B",
"forge.rag.embeddings.dimensions": 0   // 0 = padrão do modelo (1024)
```
Observações:
- **Não coloque `/embeddings` no fim da URL** — a extensão adiciona sozinha (mesma convenção do hub
  interno).
- **Densidade do vetor** (`dimensions`): `0` usa o padrão do modelo (1024). Valores menores
  (512/256) economizam memória com leve perda de precisão. **Mudar a densidade exige reindexar.**
- **Sem endpoint acessível**, o FORGE cai automaticamente para busca lexical (por palavra-chave) —
  funciona 100% offline, sem você fazer nada.

---

## 12. Distribuir configurações para todos

Você não quer que cada dev configure manualmente. Opções:
- **Configurações de organização/política** do VSCode (managed settings) — empurre o bloco `forge.*`
  para todas as máquinas via sua ferramenta de gestão (Intune, GPO, etc.).
- **Settings compartilhado do projeto** — coloque um `.vscode/settings.json` no repositório-base com
  as configurações comuns (gateway, egress, embeddings).

Exemplo de bloco padrão para o time:
```jsonc
{
  "forge.license.mode": "gateway",
  "forge.gateway.url": "https://gateway.interno:8787",
  "forge.egress.allowExternal": false,
  "forge.egress.allowedHosts": ["gateway.interno", "hub-gpus.claro.com.br"],
  "forge.rag.embeddings.url": "https://hub-gpus.claro.com.br/embed06b/v1",
  "forge.rag.embeddings.model": "Qwen/Qwen3-Embedding-0.6B"
}
```

**Endurecer o gate do Modo Projeto (opcional).** Por padrão, num projeto **Python** gerado sem
`mypy` disponível, o conjunto compila mas o **contrato cross-file** (import/atributo fantasma) fica
sem verificação — o dev vê um aviso e pode clicar *"Aplicar sem verificar contrato"*. Com:
```jsonc
"forge.gate.blockUnverifiedContract": true
```
esse escape **some**: enquanto o contrato não for verificado de fato, ficam bloqueados o **Aplicar
tudo**, o **"Forçar bloqueados"** e o **Aplicar de cada cartão** do projeto (senão bastaria aplicar
arquivo a arquivo). Vale também quando o gate inteiro não pôde rodar (ex.: máquina **sem Python**) —
menos verificação nunca significa menos bloqueio. O caminho do dev: **Preparar ambiente** (cria o
venv) e **Re-verificar contrato** (o gate instala o mypy no venv e re-verifica as **mesmas**
propostas, sem regenerar nada).

Detalhes que importam para a política valer:
- O setting tem **escopo `machine`**: um `.vscode/settings.json` commitado no repositório **não**
  consegue desligá-lo (distribua-o via **managed settings de usuário** — Intune/GPO — e não pelo
  settings do repo). Ele também **ignora de propósito** o mestre `forge.validation.gateBlocksApply`,
  que é sobrescritível por workspace.
- A política se aplica a projetos **Python** (é onde o mypy é o verificador de contrato); demais
  linguagens seguem o comportamento padrão.
- Em rede **sem acesso ao PyPI**, disponibilize um **mirror interno**
  (`pip config set global.index-url …`) antes de ligar — sem mypy instalável, projetos Python ficam
  bloqueados até o ambiente ser preparado.

---

## 13. Revogar e rotacionar chaves

**Revogar uma licença** (ex.: dev saiu da empresa):
```bash
node admin-cli/forge-admin.mjs revoke --subject joao@claro.com
```
Isso adiciona o dev à lista `admin-cli/keys/revocations.json`. **Sincronize esse arquivo com o
gateway** — na próxima validação, a licença é recusada.

**Rotacionar o par de chaves** (boa prática periódica, ou se suspeitar de vazamento):
1. `npm run keygen --key-id ed25519-2027-01` (gera um par novo);
2. reconstrua e redistribua a extensão (Passo 3);
3. reemita as licenças (Passo 2).
As licenças antigas deixam de validar (a chave embutida mudou).

---

## 14. Checklist de produção

- [ ] Chave privada com **backup seguro** e fora de qualquer repositório.
- [ ] Extensão **reconstruída** após o `keygen` (chave pública atual embutida).
- [ ] Gateway no ar, **atrás de TLS/mTLS** interno, com `forge.license.mode=gateway`.
- [ ] `forge.egress.allowExternal = false` e `allowedHosts` só com endereços internos (avalie
      `trustInNetwork: false` para endurecer o intra-rede).
- [ ] Langfuse configurado com **`secretKey` apenas no gateway** e política de `CAPTURE` definida
      (LGPD).
- [ ] `forge.observability.mode = "gateway"` distribuído aos devs (eventos de workflow governados;
      e `pricing` definido se quiser custo em R$ nos traces).
- [ ] Catálogo de **skills versionado** e revisado; **MCP** com allowlist e aprovação.
- [ ] Endpoint de **embeddings** acessível (ou ciência de que cairá para lexical).
- [ ] Processo de **emissão/revogação** de licenças documentado.
- [ ] Configurações distribuídas para os devs (managed settings ou `.vscode/settings.json`).

---

## 15. Solução de problemas

| Sintoma | Causa provável / Ação |
|---|---|
| Dev: "Chave pública não embutida" | Você não rodou `keygen` antes de empacotar. Rode `keygen` → `build` → `package`. |
| Dev: licença válida mas é recusada no gateway | Licença revogada ou assinada por outra chave. Verifique `revocations.json` e o `keyinfo.json` do gateway. |
| Gateway não sobe: "keyinfo ausente" | Rode `npm run keygen` (gera o `keyinfo.json`) ou ajuste `KEYINFO` no `.env`. |
| Traces não aparecem no Langfuse | Confira `LANGFUSE_ENABLED=true`, as chaves e a `BASEURL`. Lembre: emissão é no gateway. |
| Skill não dispara | Melhore a `description` (o "gatilho") e confirme `name` == nome da pasta. |
| MCP externo não conecta | Esperado: só endereços **internos** são aceitos (egress deny-by-default). |
| Dev no Linux: aviso de keyring | Sem cofre de senhas; instale `gnome-keyring`/`libsecret`. |

---

## 16. Segurança: o modelo de ameaça

Princípios que sustentam a segurança do FORGE:

- **O bloqueio no cliente é um dissuasor, não o controle final.** Um cliente adulterado *não* obtém
  inferência, porque o **gateway** (que serve a IA) recusa licença inválida. O controle efetivo é
  server-side.
- **A chave privada nunca sai da sua máquina.** Só a pública (que apenas *confere*) é distribuída.
- **A `secretKey` do Langfuse vive só no gateway.** Nunca no cliente, em settings, em logs ou no
  tráfego cliente↔gateway.
- **Egress deny-by-default.** Nenhuma chamada silenciosa à internet; com HubGPU, o código não sai da
  infraestrutura.
- **Credenciais só no cofre** (SecretStorage do dev ou cofre do gateway), nunca embutidas no pacote.
- **MCP com privilégio mínimo:** aprovação por ferramenta, escopo readonly por padrão, auditoria.

---

## 🔍 FORGE Review na Pull Request (revisão soberana na CI)

Além da revisão no editor (Guia do Usuário), o FORGE pode **revisar cada Pull/Merge Request
automaticamente** e comentar inline — como o CodeRabbit, mas **in-network**: o diff é revisado pelo
**HubGPU/gateway interno**, então o código **não sai da empresa**.

**Como funciona:** o workflow [`forge-review.yml`](../.github/workflows/forge-review.yml) roda o script
[`ci/forge-review.mjs`](../ci/forge-review.mjs) num **runner que alcança a rede interna**. O script pega
o diff da PR, pede uma revisão JSON ao LLM e publica os achados como comentários inline (GitHub) ou uma
nota (GitLab).

**GitHub — para ativar:**
1. Provisione um **runner self-hosted in-network** (que alcance o `LLM_BASE_URL`).
2. Em *Settings → Secrets and variables → Actions*:
   - secret **`FORGE_LLM_BASE_URL`** — ex.: `https://gateway.interno:8787/v1` (ou o HubGPU).
   - secret **`FORGE_LLM_AUTH_HEADER`** — opcional (`Header: valor`).
   - var **`FORGE_LLM_MODEL`** — ex.: `openai/gpt-oss-120b`.
   - var **`FORGE_REVIEW_RUNNER`** — o label do runner interno (ex.: `self-hosted`).
3. Abra uma PR → o FORGE comenta. **Sem `FORGE_LLM_BASE_URL`, o job é no-op** (não falha a PR).

**GitLab:** o job `forge:review` em [`.gitlab-ci.yml`](../.gitlab-ci.yml) roda em
`merge_request_event` quando `LLM_BASE_URL` está definido; ajuste a `tag` para o runner interno e defina
`LLM_BASE_URL`, `LLM_MODEL`, `GITLAB_TOKEN`.

> 🔒 O diferencial: a inteligência da revisão é a mesma de uma ferramenta SaaS, mas roda na **sua
> infraestrutura** — soberania de dados (LGPD, segredo industrial).

## 17. Glossário para leigos

| Termo | Em palavras simples |
|---|---|
| **Ed25519** | um método de assinatura digital. A chave privada assina; a pública confere. |
| **Chave pública / privada** | pública = confere licenças (segura de distribuir); privada = cria licenças (secreta). |
| **Licença** | um texto assinado que libera o uso, com validade e escopo. |
| **Gateway** | o servidor que valida a licença, fala com a IA e gera os registros. |
| **Inferência** | o ato de a IA gerar a resposta/código. |
| **Token de sessão** | uma credencial temporária que o gateway dá após validar a licença. |
| **Langfuse** | ferramenta que registra uso da IA (custo, tokens, latência). |
| **secretKey** | a senha do Langfuse — fica só no servidor. |
| **Skill** | um manual de boas práticas (`SKILL.md`) aplicado automaticamente. |
| **Quality gate** | conferência de qualidade que pode bloquear a aplicação do código. |
| **MCP** | protocolo que expõe ferramentas internas (ex.: banco de dados) à IA. |
| **Egress** | tráfego de saída para a internet; bloqueado por padrão. |
| **Embeddings** | a tecnologia da busca por significado no código do projeto. |
| **.vsix** | o arquivo-pacote da extensão, usado para instalar no VSCode. |
| **Managed settings** | configurações empurradas centralmente para as máquinas dos devs. |

---

Precisa de algo que este guia não cobre? Consulte a especificação técnica
([SPEC-codegen-vscode.md](../SPEC-codegen-vscode.md)) e os READMEs de cada componente
(`gateway/`, `admin-cli/`, `skills/`).
