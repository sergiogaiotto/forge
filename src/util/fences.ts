// Scanner genérico de blocos cercados que o modelo emite (forge-file, forge-cell). Usado tanto pelo
// host (parser autoritativo das propostas) quanto pela webview (preview ao vivo e remoção da cerca
// crua da prosa), para que AMBOS concordem sobre o que é um bloco.
//
// PROTOCOLO DA CERCA: uma cerca de abertura é um run de N crases (N>=3) imediatamente seguido pela
// linguagem (ex.: ````forge-file) e por uma fronteira (espaço/tab/quebra/fim). A cerca de FECHAMENTO
// deve ter EXATAMENTE o mesmo número de crases da abertura e estar sozinha na própria linha (apenas
// crases, tolerando espaços/CR à direita). Isso é o que permite que cercas de 3 crases DENTRO do
// conteúdo (ex.: um bloco ```bash num README) NÃO fechem o bloco — basta a abertura usar 4 crases.
//
// A igualdade EXATA protege nos DOIS sentidos: uma cerca interna mais CURTA não fecha (garantia das 4
// crases) e uma cerca interna mais LONGA também não (senão um bloco de 3 com um ```` no conteúdo
// fecharia cedo e o resto do arquivo se perderia). A tolerância a cercas malformadas que o modelo
// porventura emita (abre 3 / fecha 4, ou esquece o fechamento) é tratada SEPARADAMENTE e só no parser
// FINAL — ver finalFileBlocks/recoverOpen em fileBlocks.ts —, nunca relaxando esta detecção no meio do
// conteúdo. As primitivas findOpeningFence/findClosingFence são exportadas para esse parser final.

export interface ScannedFence {
  info: string; // restante da linha de cabeçalho após a linguagem (ex.: " path=a.py")
  content: string; // conteúdo entre abertura e fechamento (um \n final é removido)
  closed: boolean; // false enquanto a cerca de fechamento ainda não chegou (streaming)
  start: number; // índice do início da cerca de abertura
  end: number; // índice logo após as crases de fechamento (ou fim do texto, se aberto)
  fenceLen: number; // número de crases da cerca de abertura
}

// Localiza a próxima cerca de abertura de `lang` em/após `from`. Conta as crases imediatamente antes
// da linguagem: o run deve ter >=3 crases (maximal — o char antes do run não é crase), a linguagem
// deve terminar numa fronteira (espelhando o `\s+` do protocolo, assim ```forge-fileXYZ NÃO casa) e a
// cerca deve começar na COLUNA 0 (o char anterior é o início do texto ou uma quebra de linha). A
// exigência de coluna 0 é SIMÉTRICA com o fechamento (isClosingFenceLine também exige as crases
// coladas no início da linha): sem ela, uma abertura indentada casaria mas o fechamento indentado não,
// e o bloco engoliria sua própria cerca de fechamento e a cauda. Também evita que uma MENÇÃO ao
// protocolo no meio de uma string/comentário (ex.: "use ```forge-file aqui") abra um bloco.
export function findOpeningFence(
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
    const atLineStart = b < 0 || text[b] === "\n"; // coluna 0 (char imediatamente antes do run)
    if (fenceLen >= 3 && boundaryOk && atLineStart) return { start: b + 1, fenceLen, afterLang };
    i = afterLang; // pula prefixo falso, crases insuficientes ou cerca fora da coluna 0
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
export function findClosingFence(
  text: string,
  from: number,
  fenceLen: number
): { lineStart: number; end: number } | null {
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
    const content = text.slice(nl + 1, close.lineStart).replace(/\r?\n$/, ""); // tira a quebra final (LF/CRLF)
    out.push({ info, content, closed: true, start, end: close.end, fenceLen });
    i = close.end;
  }
  return out;
}
