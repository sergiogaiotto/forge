# Playbook de visualizacoes

Use este arquivo para escolher charts pela pergunta e impedir variedade decorativa.

## Sumario

1. Processo de selecao
2. Matriz de graficos
3. Configuracao minima
4. Paleta de series
5. Anti-padroes

## 1. Processo de selecao

Para cada visual, responder antes de implementar:

1. Qual pergunta de negocio ele responde?
2. Quais campos e filtros alimentam o calculo?
3. Qual agregacao e granularidade sao corretas?
4. Qual chart torna a comparacao mais facil?
5. Qual valor exato precisa aparecer em tooltip ou tabela?
6. O que aparece quando os dados faltam?

Remover o visual se a pergunta nao estiver clara.

## 2. Matriz de graficos

| Intencao | Graficos | Pre-requisitos | Evitar |
|---|---|---|---|
| valor atual | KPI, scorecard | metrica, unidade, periodo | numero sem contexto |
| meta/faixa | bullet, progress, gauge | minimo/maximo ou meta real | gauge sem alvo |
| tendencia | linha, area, sparkline | data/sequencia ordenada | linha entre categorias nominais |
| comparacao | barras, lollipop, dot plot | categorias comparaveis | eixo truncado enganoso |
| ranking | barras horizontais | ordenacao e top-N | pizza com muitas fatias |
| composicao | stacked, 100% stacked, donut/pizza | partes exclusivas de um total | soma que nao fecha |
| distribuicao | histograma, box plot, violin, ECDF | metrica e amostra suficiente | media isolada |
| relacao | scatter, bubble, hexbin | duas metricas; terceira para tamanho | conectar pontos sem ordem |
| variacao | waterfall, slope, variance bar | baseline e delta | verde/vermelho sem rotulo |
| calendario | heatmap calendario | data e metrica diaria | cor sem legenda |
| matriz | heatmap/correlation | duas dimensoes ou metricas | escalas divergentes sem centro |
| funil | funnel, barras por etapa | etapas ordenadas e denominador | funil para categorias comuns |
| fluxo | sankey | origem, destino e peso | poucos dados que cabem em barras |
| coorte | heatmap de coorte | inicio de coorte e idade | linha agregada que esconde retencao |
| geografia | mapa coropletico, simbolos, ranking | geocodigo confiavel | mapa quando ranking responde melhor |
| incerteza | intervalo, fan chart, error bars | limites ou distribuicao | previsao sem intervalo |

### Gauge

Usar somente para uma metrica limitada com zonas ou meta compreensivel. Exibir valor,
unidade, alvo e significado das faixas. Preferir bullet chart quando varias entidades
precisarem ser comparadas.

### Pizza e donut

Usar para parte-do-todo com no maximo cinco categorias relevantes. Ordenar, rotular
diretamente e exibir total. Nunca comparar varias pizzas; usar barras empilhadas.

### Box plot

Calcular Q1, mediana, Q3, IQR, whiskers e outliers. Informar tamanho da amostra. Para
publico nao tecnico, combinar com tooltip e uma frase curta sobre dispersao.

### Linha

Usar eixo temporal continuo ou sequencia ordinal defensavel. Mostrar gaps como gaps,
nao interpolar dado ausente sem indicar. Limitar series simultaneas e destacar apenas a
serie focal em vermelho Claro.

### Barras

Partir de zero, ordenar pela pergunta e usar horizontal para rotulos longos. Usar barras
divergentes para variacao positiva/negativa com zero central.

### Scatter e bubble

Exibir eixos, unidade, tamanho da amostra e correlacao apenas quando calculada. Tratar
overplotting com opacidade, jitter, hexbin ou amostragem representativa.

## 3. Configuracao minima

Todo chart deve ter:

- titulo que expresse a pergunta;
- descricao curta apenas quando o titulo nao bastar;
- eixos e unidades formatados;
- tooltip com valores exatos e contexto;
- legenda somente quando necessaria;
- estado vazio e erro;
- resize responsivo e altura estavel;
- tabela/resumo acessivel para informacao essencial;
- fonte/periodo quando nao forem globais.

## 4. Paleta de series

Reservar `#da291c` para foco/selecionado. Usar uma sequencia equilibrada:

```text
#da291c  foco Claro
#246b9e  comparacao azul
#2e7d32  positivo
#f7b731  atencao
#5f6368  neutro
#008c95  comparacao teal
#8a5a00  marrom-amarelo escuro
```

Combinar cor com label, marcador, dash ou textura. Para escala sequencial, usar uma
familia clara-escura; para divergente, usar centro neutro. Nao montar arco-iris.

## 5. Anti-padroes

- dashboard que e apenas uma tabela com cabecalho bonito;
- uma grade contendo todos os tipos de chart possiveis;
- KPI inventado para preencher espaco;
- grafico sem unidade, periodo ou denominador;
- pizza 3D, gauge decorativo e velocimetro em excesso;
- vermelho em todas as series;
- eixo duplo sem relacao clara;
- legenda distante com muitas categorias;
- tooltip como unica forma de descobrir o valor;
- label cortado, sobreposto ou menor que leitura confortavel;
- animacao que reexecuta a cada filtro e atrapalha comparacao.
