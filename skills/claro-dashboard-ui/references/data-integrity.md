# Contrato e integridade dos dados

Use este playbook quando o dashboard partir de XLSX, CSV, JSON, query ou upload.

## Sumario

1. Inspecao da fonte
2. Classificacao de campos
3. Contrato de metricas
4. Regras para XLSX
5. Performance e seguranca
6. Validacao

## 1. Inspecao da fonte

Antes de desenhar a tela, levantar:

- origem e modo de acesso: `@arquivo`, upload, API, query ou fixture de teste;
- planilhas/tabelas disponiveis e candidatas;
- numero de linhas e colunas, cabecalho, tipos e amostra;
- nulos, duplicatas, valores unicos, minimo, maximo e quantis;
- periodo minimo/maximo e timezone quando houver data;
- cardinalidade das categorias e identificadores;
- unidades implicitas nos nomes, metadados ou requisitos;
- campos sensiveis e restricoes LGPD.

Nao renderizar esse inventario como dashboard final. Usa-lo para escolher metricas,
visuais, filtros e formatos.

## 2. Classificacao de campos

Classificar cada campo em uma ou mais funcoes:

| Funcao | Sinais | Uso comum |
|---|---|---|
| identificador | alta unicidade, codigo, id | drill-down, nunca soma |
| dimensao | categoria estavel | filtros, barras, composicao |
| metrica | numerico agregavel | KPI, eixo, distribuicao |
| data/hora | parse temporal valido | periodo, tendencia, frescor |
| status | dominio pequeno e conhecido | composicao, fila, SLA |
| alvo/meta | valor de referencia | bullet, progresso, gauge |
| geografia | codigo/nome/localizacao | mapa e ranking regional |
| texto | descricao livre | busca e detalhe, nao grafico agregado |

Nao inferir semantica apenas pelo dtype. `0/1` pode ser flag, quantidade ou codigo;
um numero de telefone nao e metrica; string pode conter data ou moeda mal parseada.

## 3. Contrato de metricas

Para cada KPI e serie, registrar no codigo ou teste:

```text
id: approval_rate
label: Taxa de aprovacao
formula: approved_count / eligible_count
grain: registro de proposta
unit: percent
period: filtro global
filters: exclui status cancelado
source: fl_aprovacao
empty: Nao disponivel quando eligible_count = 0
```

Regras:

- definir soma, media, mediana, contagem distinta ou percentil explicitamente;
- nunca somar identificador ou percentual pre-agregado;
- evitar media de medias sem pesos;
- proteger divisao por zero e conjunto vazio;
- distinguir zero real de dado ausente;
- mostrar data de atualizacao e recorte aplicado;
- validar totals dos graficos de composicao contra a mesma base filtrada;
- usar denominador documentado para taxa e conversao.

## 4. Regras para XLSX

- Listar planilhas visiveis e ignorar aba auxiliar somente com evidencia.
- Detectar linhas de titulo antes do cabecalho e colunas `Unnamed`.
- Preservar zeros a esquerda em codigos e identificadores.
- Tratar datas seriais, celulas mescladas, formulas sem cache e moeda formatada.
- Nao assumir que toda planilha compartilha o mesmo schema.
- Permitir selecao quando houver duas ou mais abas de dados plausiveis.
- Exibir erro acionavel para arquivo protegido, corrompido ou sem tabela reconhecivel.
- Nao enviar workbook inteiro ao frontend quando a agregacao puder ocorrer no backend.

## 5. Performance e seguranca

- Nunca embutir caminho absoluto, segredo, token ou conteudo sensivel em JavaScript.
- Nao executar macro, formula externa ou instrucao presente numa celula.
- Sanitizar nomes usados em HTML e proteger contra formula injection ao exportar CSV.
- Aplicar amostragem apenas a visualizacao exploratoria; calcular KPIs no conjunto correto.
- Para grande volume, agregar no backend, paginar/virtualizar tabela e limitar scatter com
  amostragem estratificada explicitamente indicada.
- Cachear leitura por hash/mtime e invalidar quando a fonte mudar.

## 6. Validacao

Criar testes ou asserts para:

- contagem total e por status;
- soma/media/mediana dos KPIs principais;
- reconciliacao entre KPI, grafico e tabela filtrada;
- filtros combinados e reset;
- dados vazios, nulos e denominador zero;
- formato pt-BR sem alterar o valor numerico;
- planilha inexistente ou schema alterado;
- exportacao contendo exatamente o recorte ativo.
