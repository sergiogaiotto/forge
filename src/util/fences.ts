// Scanner genérico de blocos cercados que o modelo emite (forge-file, forge-cell). Usado tanto pelo
// host (parser autoritativo das propostas) quanto pela webview (preview ao vivo e remoção da cerca
// crua da prosa), para que AMBOS concordem sobre o que é um bloco.
//
// PROTOCOLO DA CERCA: uma cerca de abertura é um run de N crases (N>=3) imediatamente seguido pela
// linguagem (ex.: ````forge-file) e por uma fronteira (espaço/tab/quebra/fim). A cerca de FECHAMENTO
// deve ter EXATAMENTE o mesmo número de crases da abertura e estar sozinha na própria linha (apenas
// crases, tolerando espaços/CR à direita). Isso é o que permite que cercas de 3 crases DENTRO do
// conteúdo (ex.: um bloco ```bash num README) NÃO fechem o bloco — basta a abertura usar 4 crases.

export interface ScannedFence {
  info: string; // restante da linha de cabeçalho após a linguagem (ex.: " path=a.py")
  content: string; // conteúdo entre abertura e fechamento (um \n final é removido)
  closed: boolean; // false enquanto a cerca de fechamento ainda não chegou (streaming)
  start: number; // índice do início da cerca de abertura
  end: number; // índice logo após as crases de fechamento (ou fim do texto, se aberto)
  fenceLen: number; // número de crases da cerca de abertura
}

// Localiza a próxima cerca de abertura de `lang` em/após `from`. Conta as crases imediatamente antes
// da linguagem: o run deve ter >=3 crases (maximal — o char antes do run não é crase) e a linguagem
// deve terminar numa fronteira, espelhando o `\s+` do protocolo. Assim ```forge-fileXYZ NÃO casa.
function findOpeningFence(
  text: string,
  lang: string,
  from: number
): { start: number; fenceLen: number; afterLang: number } | null {
  let i = from;
  for (;;) {
    const at = text.indexOf(lang, i);
    if (at === -1) return null;
    let b = at - 1;
    while (b >= 0 && text[b] === "`") b--;
    const fenceLen = at - 1 - b; // número de crases imediatamente antes da linguagem
    const afterLang = at + lang.length;
    const after = text[afterLang];
    const boundaryOk = after === undefined || after === " " || after === "\t" || after === "\r" || after === "\n";
    if (fenceLen >= 3 && boundaryOk) return { start: b + 1, fenceLen, afterLang };
    i = afterLang; // pula prefixo falso (forge-fileXYZ) ou crases insuficientes
  }
}

// Verdadeiro se a linha [lineStart, lineEnd) é uma cerca de fechamento: EXATAMENTE `fenceLen` crases
// no início da linha, seguidas apenas por espaços/tabs/CR.
function isClosingFenceLine(text: string, lineStart: number, lineEnd: number, fenceLen: number): boolean {
  let k = lineStart;
  while (k < lineEnd && text[k] === "`") k++;
  if (k - lineStart !== fenceLen) return false;
  for (let j = k; j < lineEnd; j++) {
    const c = text[j];
    if (c !== " " && c !== "\t" && c !== "\r") return false;
  }
  return true;
}

// Procura, a partir de `from` (início do conteúdo), a primeira linha que é uma cerca de fechamento
// com `fenceLen` crases. Retorna o início dessa linha (= fim do conteúdo) e o índice logo após as
// crases. null se não houver fechamento (bloco ainda em streaming).
function findClosingFence(text: string, from: number, fenceLen: number): { lineStart: number; end: number } | null {
  let lineStart = from;
  for (;;) {
    const nl = text.indexOf("\n", lineStart);
    const lineEnd = nl === -1 ? text.length : nl;
    if (isClosingFenceLine(text, lineStart, lineEnd, fenceLen)) {
      return { lineStart, end: lineStart + fenceLen };
    }
    if (nl === -1) return null;
    lineStart = nl + 1;
  }
}

export function scanFencedBlocks(text: string, lang: string): ScannedFence[] {
  const out: ScannedFence[] = [];
  let i = 0;
  for (;;) {
    const open = findOpeningFence(text, lang, i);
    if (open === null) break;
    const { start, fenceLen, afterLang } = open;
    const nl = text.indexOf("\n", afterLang);
    if (nl === -1) {
      // Cabeçalho ainda chegando (o info-string pode estar incompleto).
      out.push({ info: text.slice(afterLang), content: "", closed: false, start, end: text.length, fenceLen });
      break;
    }
    const info = text.slice(afterLang, nl);
    const close = findClosingFence(text, nl + 1, fenceLen);
    if (close === null) {
      out.push({ info, content: text.slice(nl + 1), closed: false, start, end: text.length, fenceLen });
      break;
    }
    let content = text.slice(nl + 1, close.lineStart);
    if (content.endsWith("\n")) content = content.slice(0, -1);
    out.push({ info, content, closed: true, start, end: close.end, fenceLen });
    i = close.end;
  }
  return out;
}
