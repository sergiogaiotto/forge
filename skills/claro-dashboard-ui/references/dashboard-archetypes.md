# Arquetipos adaptativos de dashboard

Use estes arquetipos como geradores de composicao. Escolha um dominante e varie grid,
ordem, largura e navegacao. Nao reproduzir literalmente nenhuma receita.

## Sumario

1. Executivo
2. Operacional
3. Analitico
4. Preditivo
5. Jornada e funil
6. Geografico e rede
7. Regras de variacao

## 1. Executivo

Pergunta: estamos no rumo e por que?

- faixa compacta com periodo, atualizacao e filtros essenciais;
- 3 a 5 KPIs com meta e variacao;
- tendencia principal larga;
- drivers positivos/negativos e excecoes;
- ranking curto ou tabela de riscos;
- detalhes progressivos, nunca uma parede de charts.

## 2. Operacional

Pergunta: o que precisa de acao agora?

- estado atual, SLA, fila, throughput e incidentes no topo;
- alertas e excecoes antes de tendencias historicas;
- filtros por equipe, regiao, status e janela recente;
- tabela acionavel com status, idade, owner e proxima acao;
- atualizacao/frescor visivel e comportamento de auto-refresh controlavel.

## 3. Analitico

Pergunta: como os dados se distribuem e quais segmentos explicam o resultado?

- painel de filtros mais expressivo, recolhivel quando necessario;
- KPIs de contexto, nao de celebracao;
- distribuicao, box plot, scatter/hexbin, heatmap e segmentos;
- selecao cruzada entre charts e tabela;
- estatisticas e amostra visiveis sem transformar a UI em notebook.

## 4. Preditivo

Pergunta: o modelo funciona, onde erra e como afeta decisoes?

- separar desempenho do modelo de resultado de negocio;
- classificacao: precision, recall, F1, AUC, matriz de confusao e threshold;
- regressao: MAE/RMSE, residuais, previsto x real e erro por segmento;
- distribuicao do score, calibracao, lift/gain e cortes de decisao;
- explicabilidade global/local apenas quando calculada;
- data/model drift, versao, janela de treino e atualizacao;
- nunca chamar uma flag de predicao sem evidencia do pipeline.

## 5. Jornada e funil

Pergunta: onde as pessoas ou eventos avancam, param ou abandonam?

- volumes e conversoes por etapa com denominadores coerentes;
- tempo entre etapas e abandono;
- coortes por inicio e retencao;
- segmentos comparaveis por canal/produto/regiao;
- detalhe da etapa selecionada.

## 6. Geografico e rede

Pergunta: onde ocorre e qual local exige atencao?

- mapa apenas quando localizacao altera a decisao;
- ranking regional ao lado para leitura exata;
- capacidade, demanda, falha ou cobertura por local;
- zoom/drill regional e tabela de sites/municipios;
- fallback sem mapa quando geocodigo ou assets nao estiverem disponiveis.

## 7. Regras de variacao

- Alternar entre toolbar superior, rail lateral recolhivel ou filtros contextuais conforme
  quantidade e frequencia de uso.
- Usar uma visualizacao primaria larga ou duas comparacoes balanceadas; nao repetir sempre
  a mesma grade 4 KPIs + 3 charts.
- Usar tabs apenas para perspectivas diferentes, nunca para esconder uma pagina longa sem
  necessidade.
- Colocar tabela antes dos charts em operacao orientada a fila; colocar depois em analise.
- Ajustar densidade ao publico: executivo mais sintetico, analista mais exploravel,
  operador mais acionavel.
- Manter constantes tokens, acessibilidade, integridade e componentes; variar composicao,
  chart, navegacao e enfase.
