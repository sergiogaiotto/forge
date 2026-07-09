# 🔥 Guia do Usuário — FORGE

> **O que é o FORGE?** É um **assistente de programação com inteligência artificial** que vive
> dentro do VSCode (o editor de código). Você descreve, em português, o que precisa — *"limpe esta
> tabela", "crie um modelo dbt", "escreva um treino em PyTorch"* — e o FORGE escreve o código para
> você, já no padrão do seu time. Você revisa e aplica com um clique.

Este guia é para **quem vai usar** o FORGE no dia a dia (cientistas e engenheiros de dados/IA).
Não exige conhecimento de administração — é só seguir os passos. Se você for o **administrador**
(quem emite licenças e configura o ambiente), veja o [Guia do Admin](GUIA-DO-ADMIN.md).

---

## Índice
1. [Antes de começar](#1-antes-de-começar)
2. [Instalar a extensão](#2-instalar-a-extensão)
3. [Primeiro uso: licença e provedor](#3-primeiro-uso-licença-e-provedor)
4. [Gerando seu primeiro código](#4-gerando-seu-primeiro-código)
5. [Conhecendo a tela](#5-conhecendo-a-tela)
6. [Recursos do dia a dia](#6-recursos-do-dia-a-dia)
7. [Configurações que você pode mexer](#7-configurações-que-você-pode-mexer)
8. [Atalhos e comandos](#8-atalhos-e-comandos)
9. [Problemas comuns (FAQ)](#9-problemas-comuns-faq)
10. [Sua privacidade](#10-sua-privacidade)
11. [Glossário para leigos](#11-glossário-para-leigos)

---

## 1. Antes de começar

Você vai precisar de:

- **VSCode** instalado (versão 1.90 ou mais nova). É o editor onde o FORGE roda.
- Estar **conectado à rede interna da Claro** (no escritório ou pela VPN) — é por ela que o FORGE
  fala com a IA da empresa (o "HubGPU"). Sem a rede, dá para testar com uma IA externa (explicado
  mais adiante).
- Uma **chave de licença** — um texto que começa com `FORGE-...`, fornecido pelo seu administrador.
  É o que "destrava" o FORGE.
- **Opcional:** ter as ferramentas `ruff` e `mypy` instaladas (são "corretores automáticos" de
  código Python). Elas deixam o FORGE conferir a qualidade do que gera. Se você não tiver, tudo
  funciona igual — só não roda essa conferência. Para instalar (se quiser):
  ```bash
  pip install ruff mypy
  ```

---

## 2. Instalar a extensão

A extensão é entregue num arquivo chamado **`forge-<versão>.vsix`** (um "pacote" da extensão —
por exemplo, `forge-2.8.0.vsix`; o número acompanha a versão distribuída).

### Jeito 1 — pela tela do VSCode (recomendado)
1. Abra o VSCode.
2. Clique no ícone de **Extensões** na barra lateral (parece quatro quadradinhos) ou tecle
   `Ctrl+Shift+X`.
3. No topo desse painel, clique no botão **`...`** (três pontinhos).
4. Escolha **"Install from VSIX..."** (Instalar do VSIX).
5. Encontre e selecione o arquivo `forge-<versão>.vsix`.
6. Aguarde a mensagem de sucesso e clique em **"Reload"** (Recarregar) se aparecer.

### Jeito 2 — pelo terminal
Se você se sente à vontade com o terminal:
```bash
code --install-extension forge-<versão>.vsix
```
Depois, reabra o VSCode.

### Confirmando que instalou
Olhe a **barra de ícones na lateral esquerda** do VSCode. Deve aparecer um ícone de **chama 🔥
(FORGE)**. Clique nele — abre o painel do FORGE. Pronto, está instalado!

> 💡 Se o ícone não aparecer, recarregue a janela: tecle `Ctrl+Shift+P`, digite **"Reload Window"**
> e tecle Enter.

---

## 3. Primeiro uso: licença e provedor

Na primeira vez, o FORGE pede duas coisas: **a licença** e **qual IA usar**. É um pequeno
assistente de 2 passos no painel da direita.

### Passo 1 — Ativar a licença
1. No campo de licença, **cole a chave** que o admin te passou (aquele texto `FORGE-...`).
2. Clique em **"Verificar e ativar"**.
3. Se a chave for válida, aparece em verde algo como: *"Assinatura válida · org claro · expira em
   2027-12-31"*. ✅

> ❓ *Por que precisa de licença?* É como uma "carteirinha" que comprova que você tem permissão de
> usar a IA da empresa. Sem ela, o FORGE não gera nada.

### Passo 2 — Escolher o provedor (a IA)
O FORGE já vem com a opção da Claro pré-selecionada:

- **HubGPU · gpt-oss-120b** — é a IA interna da Claro. Os campos já vêm preenchidos
  (endereço, modelo, tempo limite). Você não precisa mexer.
1. Clique em **"Testar conexão"**. Se aparecer "Conexão OK", ótimo.
2. Clique em **"Concluir configuração"**.

*(Opcional)* Logo abaixo há um cartão **"Embeddings (RAG)"** com um botão **"Testar embedding"** —
isso confere a "busca inteligente" no seu projeto. Pode clicar para testar; se não conectar, o
FORGE usa uma busca mais simples automaticamente (não tem problema).

Feito isso, o assistente some e o painel fica pronto para uso. 🎉

> 🌐 **Está fora da rede da Claro (ex.: testando em casa)?** O HubGPU não vai conectar. Nesse caso,
> escolha **OpenAI** ou **Anthropic Claude**, cole a **sua chave de API** desses serviços, e libere
> o acesso à internet (veja a [seção 7](#7-configurações-que-você-pode-mexer)). Por segurança, o
> FORGE bloqueia a internet por padrão.

---

## 4. Gerando seu primeiro código

Agora a parte divertida. Vamos a um exemplo prático.

1. **Abra um arquivo** do seu projeto no VSCode (por exemplo, um arquivo Python `.py`). O FORGE
   olha o arquivo aberto e outros trechos do seu projeto para entender o contexto.
2. No painel do FORGE, há um **campo de texto na parte de baixo** ("Pergunte ou descreva a
   tarefa…"). Escreva o que você quer, em português normal. Exemplo:
   > *Limpe o churn.parquet: remova duplicados, ajuste os tipos das colunas e trate os valores
   > nulos com segurança.*
3. Tecle **Enter** para enviar. *(Para pular linha sem enviar, use **Shift+Enter**.)*
4. Observe o FORGE trabalhar:
   - Pode aparecer uma etiqueta **"Skill aplicada"** (ex.: *pandas-defensive-pipelines*) — significa
     que ele reconheceu o assunto e está seguindo as boas práticas daquele domínio.
   - A **resposta vai surgindo aos poucos** (em "streaming"), como se estivesse digitando.
   - No fim, aparece um **cartão de diferenças (diff)** mostrando o código proposto (em verde, as
     linhas adicionadas).
   - E uma faixa de **validação** (ex.: *"Validação local · ruff + mypy · gate ok"*) dizendo se o
     código passou na conferência de qualidade.
5. Agora **você decide** (botões abaixo do cartão):
   - **✅ Aplicar** — grava a mudança no arquivo e o abre para você ver. *Se a conferência tiver
     reprovado (e o time exigir aprovação), o botão fica travado até o problema ser corrigido.*
   - **🔍 Ver diff** — abre a tela de comparação do VSCode (lado a lado: como está × como ficaria).
   - **✕ Descartar** — ignora a sugestão.

E só. Você revisa, aplica, segue codando. Pode continuar a conversa pedindo ajustes
("agora adicione um teste", "renomeie a função para `limpar_base`", etc.).

> 🛑 **Quer parar uma geração no meio?** Enquanto o FORGE está "pensando", o botão de enviar vira um
> **✕**. Clique para interromper.

---

## 4.1. Depois de aplicar: rodar e revisar

Aplicar não é o fim — o FORGE ajuda a **fazer o código funcionar** e a **revisá-lo**, sem sair do
painel.

**▶️ Executar (com auto-cura)**
- Depois de **Aplicar**, aparece o botão **Executar** na proposta. Clique para rodar o arquivo
  (o FORGE escolhe o comando certo: `python`, `node`, notebook, etc.).
- O resultado aparece num cartão: ✅ sucesso ou 🔴 erro, com a saída do terminal (clique para
  expandir).
- **Deu erro?** Clique em **"Corrigir com FORGE"** — ele lê o erro, propõe a correção e você aplica e
  roda de novo. É o ciclo *rodar → corrigir → rodar* sem copiar-colar erro nenhum.
- Também dá para rodar o arquivo aberto pelo comando **FORGE: Executar arquivo atual**.

**🧪 Modo TDD (testes primeiro)**
- No compositor, ligue o selo **TDD** antes de enviar a tarefa. O FORGE escreve **os testes primeiro**
  (pytest) e, em seguida, a implementação — você recebe dois diffs (teste + código) para aplicar.
- Clique no selo **Testes** (ou **FORGE: Rodar testes**) para rodar a suíte. Se algum teste falhar, use
  **"Corrigir com FORGE"** — ele lê a saída do pytest e ajusta o código, repetindo até passar.

**🔎 Revisar alterações (revisão por IA, interna)**
- Clique no botão **Revisar** (✓ no topo do painel) ou use **FORGE: Revisar alterações**.
- O FORGE revisa **suas mudanças** (`git diff`) sob várias lentes — correção, segurança, dados/LGPD,
  performance e estilo — e lista os achados por severidade (🔴/🟠/🟡), com a correção sugerida.
- Quando a correção é objetiva, ela vem como um **diff aplicável** (botão Aplicar).
- 🔒 A revisão roda **na rede interna (HubGPU)** — seu código **não sai da empresa** (diferente de
  ferramentas SaaS de revisão).

## 5. Conhecendo a tela

O painel do FORGE tem três áreas:

**No topo:**
- O **nome do modelo** em uso (ex.: *HubGPU · gpt-oss-120b*). Clicar nele abre as configurações.
- Um indicador **"Licença ativa"** (bolinha verde).
- Ícones de **nova conversa** (limpa o bate-papo) e **configurações**.

**No meio (a conversa):**
- Suas mensagens (à direita) e as respostas do FORGE (à esquerda), com as skills aplicadas, os
  cartões de código e a validação.

**Na parte de baixo (o campo de escrever):**
- Onde você digita as tarefas. Os "selos" ao lado (Skills, MCP, modelo) são informativos.

**Na barra inferior (status):** veja a [legenda na seção 6](#a-barra-de-status-explicada).

### 🪟 Colocar o FORGE na direita da janela
Por padrão o FORGE abre na **lateral esquerda**. Se você prefere ele na **direita** (deixando o
explorador de arquivos à esquerda), mova-o uma única vez — o VSCode lembra da posição:

- **Arrastando:** abra a barra da direita com `Ctrl+Alt+B` (menu *View → Appearance → Secondary
  Side Bar*) e **arraste o ícone 🔥 FORGE** da esquerda para a área da direita.
- **Pelo comando:** `Ctrl+Shift+P` → **"View: Move View"** → escolha **FORGE** → escolha
  **Secondary Side Bar**.
- **Clique direito** no título "FORGE" → **Move View** → **Secondary Side Bar**.

Depois de mover, use o atalho **FORGE: Abrir na direita** (`Ctrl+Shift+P`) — ou o botão de barra
lateral no topo do painel — para abrir o FORGE na direita sempre que precisar.

> Isso coloca **só o FORGE** na direita; o explorador de arquivos continua na esquerda. (Não
> confunda com mover *toda* a barra lateral para a direita.)

---

## 6. Recursos do dia a dia

### Anexar contexto (botão 📎)
No compositor, o botão **📎** abre um menu para dar mais contexto ao FORGE:
- **Anexar seleção do editor** — o trecho que você selecionou.
- **Anexar arquivo do workspace** — escolha um arquivo do projeto.
- **Enviar do computador** — um arquivo de texto do seu disco (ex.: um CSV de amostra, um log de erro).

Os anexos aparecem como **chips** (remova no **×**) e entram no contexto da próxima mensagem. Tudo
fica **na rede interna**. *"Buscar na web" aparece bloqueada de propósito* — o FORGE não acessa a
internet pública (soberania de dados); busca externa, se necessária, é configurada pelo admin via fonte interna.

### Skills (habilidades)
São como "manuais de boas práticas" que o FORGE aplica **sozinho** quando o assunto bate. Há skills
para pandas, polars, SQL, dbt, Airflow, Spark, PyTorch, MLOps, qualidade de dados e análise
exploratória. **Você não precisa configurar nada** — quem cuida do catálogo é o admin. Quando uma
skill é usada, aparece a etiqueta "Skill aplicada".

### Busca no seu código (RAG)
O FORGE lê o seu projeto e usa os trechos mais relevantes para responder melhor. Isso acontece
nos bastidores. Na barra de status você vê o "modo" dessa busca:
- **RAG embeddings** = busca inteligente (semântica), na rede da Claro.
- **RAG lexical** = busca por palavras-chave (quando a busca inteligente não está disponível).
- **RAG indexando…** = ele ainda está lendo seu projeto (espere alguns segundos).

Trocou muitos arquivos e quer atualizar? Use o comando **"FORGE: Reindexar codebase"** (veja a
[seção 8](#8-atalhos-e-comandos)).

### Conferência de qualidade (quality gate)
Algumas skills checam o código gerado com ferramentas como `ruff`/`mypy`. Se você tiver essas
ferramentas instaladas e o time exigir, o botão **Aplicar** só libera se passar. Se as ferramentas
não estiverem instaladas, aparece "indisponível" — e isso **não** te impede de aplicar.

### Notebooks Jupyter (.ipynb) — célula a célula
Com um notebook aberto, o FORGE edita **por célula**, sem reescrever o arquivo:
- Ele propõe **inserir** uma célula nova ou **substituir** uma célula específica — você aplica com
  **Inserir célula** / **Substituir célula [N]**, e o resto do notebook (outras células, saídas) fica intacto.
- Depois de aplicar, clique em **Executar célula**: o FORGE roda aquela célula (usando o kernel do
  notebook), **captura a saída**; se der erro, aparece **"Corrigir com FORGE"** para ajustar e rodar de novo.
- Também funciona em `.py` com marcadores `# %%`.

> Precisa de um kernel Python ativo (a extensão Jupyter/Python do VSCode fornece) para executar as células.

### Ferramentas internas (MCP)
Se o admin tiver habilitado, o FORGE pode usar ferramentas da empresa (por exemplo, consultar um
banco de dados interno). Por segurança, **toda vez** que ele quiser usar uma dessas ferramentas,
aparece um aviso pedindo sua **aprovação** — clique **Permitir** ou **Negar**.

### A barra de status explicada
Na barra cinza no rodapé do painel você verá, da esquerda para a direita:

| O que mostra | Significado |
|---|---|
| 🔥 HubGPU · gpt-oss-120b | qual IA está em uso |
| 🛡️ Licença ✓ | sua licença está válida |
| 📈 trace ✓ | a empresa está registrando uso (observabilidade), se configurado |
| 🌐 rede interna | você está operando sem sair para a internet |
| 🗄️ RAG embeddings · 312 | modo da busca no código + quantos trechos foram indexados |
| timeout 300s | tempo máximo de espera por resposta |

---

## 7. Configurações que você pode mexer

Abra as configurações em `Ctrl+,` (vírgula) e procure por **"forge"**, ou edite o `settings.json`.
As principais:

```jsonc
// --- Para testar com uma IA externa (fora da rede Claro) ---
"forge.egress.allowExternal": true,                               // libera a internet
"forge.egress.allowedHosts": ["api.openai.com", "api.anthropic.com"],

// --- Tempo limite de resposta (segundos) ---
// (editável também na tela de provedor)

// --- Busca no código (RAG) ---
"forge.rag.enabled": true                                          // liga/desliga a busca no projeto
```

> ⚠️ **Não mexa** em coisas como skills, MCP, observabilidade ou no endereço do gateway — isso é
> responsabilidade do administrador. Mexer pode quebrar o funcionamento.

---

## 8. Atalhos e comandos

Tecle `Ctrl+Shift+P` (abre a "paleta de comandos"), digite **"FORGE"** e escolha:

| Comando | O que faz |
|---|---|
| **FORGE: Abrir painel** | abre o painel do FORGE |
| **FORGE: Abrir na direita (barra secundária)** | abre/foca o painel na lateral direita |
| **FORGE: Nova tarefa** | foca o painel para uma nova pergunta |
| **FORGE: Ativar licença** | reabre a tela de licença |
| **FORGE: Configurar provedor** | troca a IA / ajusta o provedor |
| **FORGE: Executar arquivo atual** | roda o arquivo aberto e mostra a saída |
| **FORGE: Rodar testes (pytest)** | roda a suíte de testes e mostra o resultado |
| **FORGE: Revisar alterações** | revisão por IA (interna) do seu `git diff` |
| **FORGE: Reindexar codebase (RAG)** | relê o projeto para a busca |
| **FORGE: Reindexar skills** | recarrega o catálogo de habilidades |
| **FORGE: Mostrar logs** | abre o registro técnico (útil para reportar erros) |
| **FORGE: Sair** | remove sua licença e credenciais (logout) |

---

## 9. Problemas comuns (FAQ)

**"Licença recusada" / "Licença requerida"**
A chave pode estar errada, vencida, ou ser de outra instalação. Peça uma chave nova ao admin e
ative de novo.

**O botão de gerar não faz nada / pede licença**
Você ainda não ativou a licença. Refaça o [passo 1](#3-primeiro-uso-licença-e-provedor).

**"Testar conexão" falha no HubGPU**
Provavelmente você está fora da rede interna (sem VPN) ou houve instabilidade. Conecte-se à rede da
Claro e tente de novo. Para testar fora da rede, use um provedor externo (seção 7).

**A validação aparece como "indisponível"**
As ferramentas `ruff`/`mypy` não estão instaladas no seu computador. Instale-as (`pip install ruff
mypy`) ou ignore — não impede o uso.

**O chip mostra "RAG lexical" em vez de "embeddings"**
A busca inteligente não conseguiu conectar (normal fora da rede). O FORGE continua funcionando com
a busca por palavras-chave.

**Apareceu um aviso sobre "keyring" (no Linux)**
Seu sistema não tem um cofre de senhas configurado. Suas credenciais podem não ficar protegidas.
Peça ajuda ao TI para instalar um keyring (ex.: `gnome-keyring`).

**Como reportar um erro?**
Rode **FORGE: Mostrar logs**, copie o conteúdo e envie ao seu admin/suporte.

---

## 10. Sua privacidade

- Sua **licença e suas chaves de API** ficam guardadas no **cofre seguro do VSCode**
  (SecretStorage) — **nunca** em arquivos de texto à vista ou em logs.
- Quando você usa o **HubGPU**, seu código **não sai da infraestrutura da Claro**.
- O FORGE **bloqueia a internet por padrão** ("deny-by-default"): ele só fala com os endereços
  internos autorizados. Nada é enviado para fora sem liberação explícita.

---

## 11. Glossário para leigos

| Termo | Em palavras simples |
|---|---|
| **Extensão** | um "aplicativo" que se instala dentro do VSCode para dar novas funções. |
| **Provedor / Modelo** | a inteligência artificial que escreve o código (HubGPU, OpenAI, etc.). |
| **HubGPU** | a IA interna da Claro, rodando na rede da empresa. |
| **Licença** | sua "carteirinha" que libera o uso. |
| **Skill** | um manual de boas práticas que o FORGE aplica sozinho. |
| **Diff** | a comparação "antes × depois" mostrando o que vai mudar no arquivo. |
| **RAG** | a busca que o FORGE faz no seu projeto para responder com mais contexto. |
| **Embeddings** | a tecnologia da "busca inteligente" (por significado, não só palavras). |
| **Quality gate** | a conferência automática de qualidade do código gerado. |
| **MCP** | ferramentas internas que o FORGE pode usar (ex.: consultar um banco). |
| **SecretStorage** | o cofre seguro do VSCode onde ficam suas senhas/credenciais. |
| **Egress** | tráfego de saída para a internet. O FORGE bloqueia por padrão. |

---

Dúvidas que este guia não cobre? Fale com o administrador do FORGE no seu time.
