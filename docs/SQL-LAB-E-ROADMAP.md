# FORGE SQL Lab e roadmap profissional

## O que existe na versão 2.15

O FORGE agora oferece um motor DuckDB embutido para análise SQL local e offline no Windows x64.
Ele não exige `duckdb.exe`, PostgreSQL, Docker ou um servidor externo. O banco persistente fica em
`.forge/sql/lab.duckdb` e é ignorado pelo Git.

Fluxo recomendado:

1. Execute `FORGE: Abrir SQL Lab local` ou `/sql-lab`.
2. Use o arquivo `.forge/sql/lab.sql` para consultas e selecione o SQL que deseja executar.
3. Execute `/executar-sql forge-local`. Leituras rodam diretamente. Escritas locais exigem confirmação.
4. Use `/importar-schema @caminho/schema.sql` para indexar DDL sem executar o arquivo.
5. Use `/validar-sql`, `/plano-sql` e `/tunar-sql` no arquivo SQL ativo.
6. Com a proposta `.tuned.sql` aberta, use `/comparar-sql` para comparar os planos estimados.
7. Quando for seguro medir, use `/analisar-sql` para obter métricas observadas com consentimento.

O catálogo `.forge/sql/catalog.json` contém apenas metadados estruturais extraídos de `CREATE TABLE`,
PKs, FKs, índices e comentários. Ele entra no grounding, no gate semântico e no tuning. Reimportar a
mesma fonte substitui somente aquela fonte.

## Governança e isolamento

- O DuckDB roda em um Worker separado. Timeout encerra o Worker e a consulta.
- Acesso a arquivos fica limitado ao workspace; acesso externo e instalação automática de extensões
  DuckDB ficam desabilitados.
- Memória, disco temporário e threads são limitados por `forge.sqlLab.*`.
- Amostras continuam sujeitas a limite de linhas e máscara de PII.
- Escritas exigem confirmação. `DROP` e `TRUNCATE` permanecem bloqueados sem override.
- O VSIX é específico por plataforma porque o DuckDB usa binários nativos.

## Dialetos e tuning

`forge.sql.dialect` pode fixar o dialeto ou usar `auto`. A resolução automática considera, nesta ordem,
a configuração explícita, a conexão, o sufixo do arquivo, como `consulta.postgres.sql`, a sintaxe
detectada e, por fim, ANSI.

O DuckDB é o laboratório local, não um simulador perfeito de Oracle, PostgreSQL ou BigQuery. Para
tuning autoritativo, o FORGE consulta `EXPLAIN` ou dry-run no banco de destino configurado. A proposta
de tuning recebe SQL, dialeto, versão informada na conexão, evidências estruturadas do plano e schema
indexado, e deve preservar semântica, granularidade, colunas e tipos de saída.

O cockpit normaliza os planos de PostgreSQL, Oracle, BigQuery e DuckDB em métricas, operadores, hotspots
e hash. `/plano-sql` é estimado e seguro para o primeiro diagnóstico. `/analisar-sql` é observado:
PostgreSQL e DuckDB executam o `SELECT` por `EXPLAIN ANALYZE`; Oracle consulta `V$SQL` +
`DBMS_XPLAN.DISPLAY_CURSOR`; BigQuery lê `INFORMATION_SCHEMA.JOBS_BY_PROJECT`. A análise observada sempre
exige confirmação e fica no trail de permissões.

`/comparar-sql` calcula deltas determinísticos entre o original e o `.tuned.sql`, mas não confunde plano
melhor com prova de correção. Equivalência de resultados e benchmark observado continuam sendo etapas
separadas. Custos Oracle/PostgreSQL/DuckDB são unidades do otimizador, não moeda; BigQuery fornece bytes
processados/faturados, cuja conversão financeira depende de preço autoritativo.

## Roadmap

### 2.13–2.15, fundação e cockpit entregues

- DuckDB embutido e persistente.
- Importação local de DDL e catálogo unificado com dbt e snapshots de warehouse.
- Validação explícita por dialeto, plano real e tuning orientado por evidência.
- Comandos no chat e na Command Palette.
- Parsers estruturados de planos PostgreSQL, Oracle, BigQuery e DuckDB.
- Hotspots de scan, join, spill, partição e cardinalidade; métricas e hash do plano.
- Análise observada consentida, trail de auditoria e comparação A/B original versus `.tuned.sql`.

### Próxima etapa

- Importação assistida de CSV, Parquet e XLSX com preview de tipos e confirmação.
- Árvore visual interativa do plano, histórico de hashes e regressão por release.
- Verificação de equivalência por agregados/amostra antes do benchmark observado.
- Pacotes nativos separados para macOS e Linux em uma matriz de CI.

### Evolução corporativa

- Introspecção ampliada de constraints, partições, estatísticas e índices por banco.
- Perfis versionados de Oracle 19c/26ai, PostgreSQL, BigQuery, Snowflake e Databricks.
- Benchmark A/B governado no banco de destino, com limites de custo e tempo.
- PGlite opcional para testes de compatibilidade PostgreSQL, sem substituir o PostgreSQL real no tuning.
- Integração com catálogo corporativo via MCP para lineage, ownership, classificação LGPD e políticas.
