# Auditoria — Geração de Código no Modo Projeto

> Data: 2026-07-05 · Escopo: geração de projeto completo (Modo Projeto / Fase F) ·
> Método: auditoria de uma sessão real + verificação estática do projeto gerado + auditoria do
> código de orquestração do FORGE + revisão multi-agente (censo, orquestração, 5 lentes, juiz, síntese).

## 1. Veredito

O Modo Projeto gerou um projeto Python + Hexagonal + FastAPI + Jinja (workspace `teste`) a partir de um
blueprint aprovado: **15 arquivos, todos com selo "✓ completo"**, a Definição de Pronto marcando
**✓ Aplicado · ✓ Gate**. E mesmo assim **o projeto não roda** — e o FORGE selou-o como pronto.

```
uvicorn src.main:app  →  ImportError: cannot import name 'OrderStatus' from 'src.domain.entities'
```

O Gate atual mede **completude** (arquivo presente, sem reticências/truncamento), nunca **correção**
(compila? importa? os contratos entre arquivos casam?).

## 2. Evidência de máquina

`mypy` sobre o projeto gerado — **20 quebras de contrato cross-file em 6 dos 15 arquivos**:

```
create_order.py:6   error: Module "src.domain.entities" has no attribute "OrderStatus"
create_order.py:29  error: Unexpected keyword argument "order_id" for "Order"
create_order.py:29  error: "type[UUID]" has no attribute "new"
create_order.py:40  error: "Order" has no attribute "order_id"
create_order.py:40  error: Argument 2 to "process_payment" has incompatible type "Callable[[], Money]"; expected "Money"
pydantic_schemas.py:29  error: Unexpected keyword argument "min_items" for "Field"
sqlalchemy_repository.py: 8 erros (order.order_id, UUID.id, kwarg order_id, Column types)
routes.py:19  error: Module "pydantic_schemas" has no attribute "OrderCreateRequestSchema"; maybe "OrderCreateSchema"?
main.py:69-70 error: "APIRouter" has no attribute "get_create_order_usecase"
```

`pytest --collect-only` — **os testes gerados nem coletam** (mesmo import fantasma):

```
ERROR tests/unit/test_create_order.py — ImportError: cannot import name 'OrderStatus'
ERROR tests/unit/test_entities.py     — ImportError: cannot import name 'OrderStatus'
no tests collected, 2 errors
```

Outros achados estruturais confirmados:
- **Nenhum `__init__.py`** em 11 diretórios de pacote (namespace packages implícitos).
- **`src/interface/web/templates/` não existe**, mas `routes.py`/`jinja_templates.py` renderizam `index.html` de lá.
- **README truncado e mal-costurado** no fim (`respect`|`ivo` = costura de continuação; `## Licença / Este projeto\`` cortado) e com prosa de chat vazada ("os blocos acima", "basta copiar cada bloco").
- **Código morto/duplicado**: dois routers (`web/routes.py` e `http/fastapi_router.py`) com endpoints sobrepostos; `jinja_templates.py` não é usado por `routes.py` (que instancia `Jinja2Templates` inline).

## 3. Causa-raiz (verificada, não sintoma)

A geração guiada é **passada única**: `buildProjectFromBlueprintPrompt` monta um prompt com a lista de
arquivos e um único `task.run()` emite os 15 numa resposta só. A única defesa de coerência é uma *frase*
no prompt ("REUSE exatamente os nomes de portas/interfaces"). Não basta.

A camada de domínio (`entities.py`/`value_objects.py`) saiu **coerente e limpa**, mas **todo consumidor**
— use-cases, adapters, composition root **e os próprios testes** — alucinou uma API convencional
diferente. Há dois modelos mentais no mesmo projeto:

| O domínio EMITIU | Todo o resto ASSUMIU |
|---|---|
| `Order.id`, `status: str = "pending"` | `Order.order_id`, enum `OrderStatus.PENDING/COMPLETED/FAILED` |
| `total()` é método | `order.total` como propriedade |
| `OrderId = UUID` (alias) | `OrderId.new()`, `.id` sobre o UUID |

O modelo esqueceu a API que ele mesmo escreveu 5 blocos antes.

### Por que o Gate não pega (mecanismo confirmado no código do FORGE)

1. `SkillValidator.run` escreve **um único** `candidate.py` num temp isolado (`src/skills/SkillValidator.ts:36-42`)
   → mypy roda cego aos arquivos-irmãos; todo o drift é cross-file.
2. `validatorsFromStack` marca **todos** os validadores como `gate: false` / advisory (`src/skills/stackValidators.ts:32`)
   → mypy roda, mostra no cartão, mas **nunca bloqueia**. O comentário na linha 25 já admite que `tsc` é
   "não confiável arquivo-a-arquivo (precisa do projeto)".
3. A reconciliação final marca "complete" só por **presença** do arquivo (`src/core/Controller.ts:1836-1852`).
4. **A máquina de bloqueio já existe** e está ociosa: `gateBlocksApply()` é `true` por padrão
   (`src/config/ManagedConfig.ts:73`) e `applyProposal` recusa quando `!entry.gateOk`
   (`src/core/Controller.ts:2280`). Falta apenas alimentá-la com um veredito de **projeto inteiro**.

## 4. As 8 causas-raiz

| # | Causa | Evidência |
|---|---|---|
| CR-1 | **Passada única sem realimentação de contrato** (dominante) | `create_order.py:40` usa `order.order_id`; a entidade tem `id` |
| CR-2 | "Coerência" é instrução aspiracional, sem mecanismo | `routes.py:20` importa `OrderCreateRequestSchema`; o real é `OrderCreateSchema` |
| CR-3 | Type alias tratado como classe wrapper | `create_order.py:29` `OrderId.new()` sobre `OrderId=UUID` |
| CR-4 | Gate valida arquivo isolado, não o conjunto | 20 erros cross-file; 0 capturados |
| CR-5 | Definição de Pronto = completude, não corretude | `main.py:69` `dependency_overrides` em atributo inexistente de `APIRouter`, selado como pronto |
| CR-6 | Cegueira de versão de framework | `pydantic_schemas.py`: `@validator`, `orm_mode`, `min_items` (Pydantic v1) num projeto v2 |
| CR-7 | Estrutura incompleta (artefatos não-código) | zero `__init__.py`; `templates/index.html` ausente |
| CR-8 | **Charter ignorado** | `.forge/project.md` pede "agente de IA p/ P&D"; saiu Order/Payment. `generateBlueprint` (`Controller.ts:767`) nem injeta o charter no passo do blueprint |

## 5. Recomendações priorizadas (em ondas)

> **A boa notícia:** a parte mais difícil — bloquear o "Aplicar" quando o gate falha — **já está
> construída** (item 4 da §3). Falta alimentá-la com um veredito de projeto inteiro.

### Onda 1 — Terra firme: gate que prova o problema e bloqueia (impacto máximo, esforço médio)

- **1.1 Gate WORKSPACE-WIDE** *(a fundação)*. Ao final da geração, materialize **todas** as propostas
  juntas numa árvore temp (com `__init__.py` sintéticos) e rode `mypy`/`compileall` sobre o **conjunto**,
  uma vez, como `gate: true`. Propague o resultado para o `gateOk` de cada arquivo.
  *Onde:* novo `runProjectGate()` chamado em `Controller.ts:1836`; extrair o exec/parse de
  `SkillValidator.runOne`; degradar para advisory quando a ferramenta faz `skipped`.
- **1.2 Import-check + gerador de `__init__.py`** — pega o que nem o mypy por-arquivo veria (o
  `ImportError` do uvicorn, pacotes implícitos). Extensão barata do 1.1.
- **1.3 Injetar charter + requirements no prompt** — passe o `purpose` de `.forge/project.md` e as
  versões pinadas ("Pydantic v2: `field_validator`, `ConfigDict`, `min_length`") no
  `buildBlueprintSystemPrompt` **e** no `buildProjectFromBlueprintPrompt`. Ataca CR-6 e a metade barata de
  CR-8. *Reuso:* o charter já é carregado via `renderProfileBlock`.
- **1.4 Regra `NO_PHANTOM_SYMBOL`** — irmã da `NO_ELLIPSIS_RULE`: "proibido referenciar
  classe/enum/campo/método que não esteja no contrato ou já emitido nesta resposta". Custo ~zero.

### Onda 2 — Fechar o ciclo detecção → correção

- **2.1 Loop de auto-reparo dirigido pelo gate**. Quando o gate da Onda 1 reprova, re-peça **só os
  arquivos reprovados**, injetando os erros exatos do mypy + o **contrato real** dos arquivos que passaram.
  Teto rígido (~2 rodadas); o gate continua bloqueando o apply se não fechar — nunca entrega quebrado em
  silêncio.

### Onda 3 — Eliminar o drift na origem (Fase G do roadmap)

- **3.1 Geração 1-arquivo-por-vez**. Gerar cada arquivo numa Task própria, em ordem topológica
  (`topoSort` já existe), injetando no contexto as **assinaturas reais já geradas** dos deps — não a
  intenção, o código. Elimina CR-1/2/3 antes de existirem. É a mudança mais cara (N chamadas in-network),
  por isso vem **depois** que o gate e o reparo já provaram e contiveram o problema.

## 6. Defeito desta sessão → recomendação que o elimina

| Defeito | Elimina |
|---|---|
| `OrderStatus` inexistente (o crash) | 1.1 gate cross-file + 1.4 + 3.1 |
| `order.order_id`, `OrderId.new()`, `total` como valor | 1.1 detecta · 3.1 previne |
| `OrderCreateRequestSchema` (nome errado) | 1.1 + 3.1 |
| `main.py` imports/`dependency_overrides` fantasma | 1.2 import-check |
| Pydantic v1 em projeto v2 | 1.3 requirements no prompt |
| faltam `__init__.py` / `templates/` | 1.2 |
| testes não coletam | 1.1 (inclui `tests/`) |
| 15 arquivos "prontos" sem compilar | 1.1 + 1.2 tornam a DoR = corretude |
| charter "P&D" → gerou e-commerce | 1.3 (charter no blueprint) |

## 7. Ponto de intervenção mínimo

Implementar **1.1 + 1.2** juntos converte a Definição de Pronto de *"arquivos presentes"* para *"o
conjunto compila e importa"* — e teria barrado esta sessão em vez de selá-la.

Arquivos-âncora: `src/skills/SkillValidator.ts:15-48`, `src/core/Controller.ts:1836` e `:2280`,
`src/core/systemPrompt.ts:268`.
