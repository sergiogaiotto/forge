# Sistema visual Claro para dashboards

Use como aproximacao baseada na referencia fornecida. Tokens oficiais do projeto sempre
vencem estes valores.

## Sumario

1. Principios
2. Tokens
3. Tipografia e espacamento
4. Componentes
5. Graficos
6. Marca e acessibilidade

## 1. Principios

- Claro reconhecivel por assinatura vermelha, contraste preto/branco e componentes,
  nao por pintar toda a pagina de vermelho.
- Dashboard de trabalho: compacto, previsivel, escaneavel e sem composicao de marketing.
- Hierarquia por tamanho, peso, espacamento e alinhamento antes de cor ou sombra.
- Conteudo abaixo deve aparecer parcialmente no primeiro viewport.

## 2. Tokens

```css
:root {
  --claro-red-700: #a91f15;
  --claro-red-600: #b52217;
  --claro-red-500: #da291c;
  --claro-red-100: #fce9e7;
  --claro-amber-500: #f7b731;
  --claro-ink-900: #1c1c1c;
  --claro-ink-600: #606060;
  --claro-border: #d7d7d7;
  --claro-canvas: #f5f6f7;
  --claro-surface: #ffffff;
  --claro-success: #2e7d32;
  --claro-info: #246b9e;
  --claro-warning: #a85d00;
  --claro-focus: #111111;
  --radius-card: 6px;
  --radius-control: 4px;
  --shadow-card: 0 1px 2px rgb(0 0 0 / 8%);
}
```

## 3. Tipografia e espacamento

- Usar fonte corporativa existente; fallback `Arial, Helvetica, sans-serif`.
- H1 de dashboard: 24-32px. Titulo de secao: 18-22px. Card: 14-16px.
- KPI: 28-40px conforme largura. Corpo/controle: 14-16px. Metadado: minimo 12px.
- Usar pesos 700 para pagina/KPI, 600 para rotulos, 400 para corpo.
- Manter letter-spacing `0`.
- Usar escala de espacamento 4, 8, 12, 16, 24, 32px.
- Usar altura de controle 36-40px no desktop e pelo menos 44px para toque.

## 4. Componentes

### Top bar

- Altura compacta, assinatura vermelha ou faixa branca com marca vermelha.
- Incluir produto/contexto, ajuda/notificacoes e perfil apenas quando funcionais.
- Nao usar hero, slogan ou imagem promocional.

### Filtros

- Agrupar numa unica toolbar ou rail claro.
- Usar label persistente acima ou associada ao controle; placeholder nao substitui label.
- Usar select, date range, segmented control e busca conforme semantica.
- Usar botao primario vermelho para aplicar somente se filtros nao forem reativos.
- Usar icone familiar para limpar/resetar, com tooltip e nome acessivel.

### KPIs

- Cards com borda de 1px, raio 6px e sombra quase imperceptivel.
- Icone em fundo vermelho suave, verde suave ou cinza apenas se agregar leitura.
- Comparacao deve indicar baseline e periodo; combinar seta/label com cor.
- Sparkline curta e opcional, sem eixo decorativo.

### Charts

- Fundo branco, gridlines discretas e plot area generosa.
- Titulo alinhado a esquerda; menu/exportar no canto oposto apenas quando funcional.
- Padding consistente; legenda proxima dos dados; tooltip com contraste alto.
- Serie focal vermelha; demais series equilibradas.

### Tabela

- Cabecalho sutil, sticky em listas longas, linhas de 40-48px.
- Texto a esquerda, numero a direita, status centralizado quando adequado.
- Hover e selecao distintos; zebra somente se ajudar em tabelas largas.
- Paginacao compacta e total de registros visivel.

## 5. Graficos

- Nao usar vermelho para positivo e negativo ao mesmo tempo.
- Usar verde somente para sucesso real, amarelo/laranja para atencao e vermelho para
  marca, serie focal ou criticidade explicitamente rotulada.
- Manter area clicavel e tooltip acessiveis.
- Nao usar sombras, bevel, textura ou perspectiva 3D nos marks.

## 6. Marca e acessibilidade

- Usar asset oficial de logo quando fornecido. Nao recriar o wordmark com fonte, SVG ou IA.
- Sem asset, escrever o nome do produto/contexto em texto neutro e preservar o vermelho.
- Garantir contraste AA e foco de 2px ou equivalente.
- Nao depender apenas de vermelho/verde; combinar icone, texto e forma.
- Verificar zoom de 200%, teclado e `prefers-reduced-motion`.
