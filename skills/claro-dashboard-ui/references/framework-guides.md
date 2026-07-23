# Guias por stack

Escolher a secao correspondente ao projeto. Reutilizar dependencias existentes antes de
adicionar novas.

## React e TypeScript

- Tipar `RawRow`, dados normalizados, filtros e view models dos charts.
- Separar `load -> normalize -> aggregate -> present`.
- Manter um unico estado de filtros e derivar KPIs/charts/tabela com memoizacao adequada.
- Preferir ECharts, Plotly, Recharts, Nivo ou a biblioteca ja usada no repo.
- Usar componentes de layout/tema existentes; nao criar design system paralelo.
- Cancelar fetch obsoleto e tratar loading/error/empty por fonte.
- Virtualizar apenas tabelas grandes; nao adicionar complexidade a 89 registros.

## HTML standalone

- Separar HTML semantico, CSS tokens e JavaScript modular.
- Nao inserir texto/dado nao confiavel por `innerHTML`.
- Para saida totalmente offline, empacotar a biblioteca localmente ou gerar HTML
  self-contained com Plotly. Nao depender de CDN.
- Manter um unico modelo de dados filtrado e re-renderizar componentes de forma previsivel.
- Incluir download CSV/PNG somente se implementado.

## Streamlit

- Usar `st.cache_data` para leitura/transformacao pura e chavear pela fonte.
- Manter filtros no sidebar ou faixa superior conforme quantidade.
- Usar `st.metric` apenas se o acabamento puder ser tematizado; criar container proprio
  quando necessario, sem HTML inseguro.
- Preferir Plotly para interacao e Altair para declaratividade quando ja disponiveis.
- Configurar pagina wide, tema central e formatos pt-BR.
- Evitar rerun caro por widget e nao ler workbook inteiro repetidamente.

## Dash

- Separar layout, callbacks, ingestao e funcoes de agregacao.
- Evitar callback circular e outputs duplicados.
- Usar `dcc.Store` apenas para dados adequados ao cliente; nao enviar dataset sensivel/grande.
- Centralizar tema e configuracao Plotly; usar callbacks para filtros compartilhados.
- Implementar loading, erro e estado sem dados no proprio graph/container.

## Python e XLSX

- Ler com pandas/polars conforme stack; selecionar engine instalada e fornecer erro claro.
- Normalizar nomes e tipos em funcao separada, preservando coluna original para auditoria.
- Calcular agregacoes no backend e enviar somente o necessario a interface.
- Nao gerar uma pagina estatica contendo apenas `df.head().to_html()`.
- Para HTML analitico offline, Plotly pode gerar bundle self-contained; avaliar tamanho.

## Verificacao visual

- Iniciar o servidor local quando necessario e informar a URL.
- Capturar desktop (por exemplo 1440x900) e mobile (por exemplo 390x844).
- Verificar loading, dados reais, filtros ativos, labels, tooltips, scroll e tabela.
- Confirmar por pixels/screenshot que canvas/SVG nao esta vazio e nao cobre controles.
- Testar teclado, zoom e ausencia de overflow horizontal fora da tabela.
