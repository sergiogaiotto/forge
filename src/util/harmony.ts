// Saneamento do formato "harmony" do gpt-oss (openai/gpt-oss servido OpenAI-compatível, ex.: HubGPU).
// O gpt-oss estrutura a resposta em CANAIS (analysis/commentary/final). Quando o gateway NÃO isola o
// canal de raciocínio no campo `reasoning_content`, o texto de análise VAZA dentro de `delta.content`
// (ex.: "Now final output is markdown string. Proceed." antes da resposta) — poluindo tudo que consome
// o texto final: o Charter (o lixo aparece no campo) e o Blueprint (quebra o JSON → plano vazio).
//
// Este util extrai SÓ o conteúdo do canal FINAL e remove os tokens de controle harmony. Puro/testável.
// Conservador de propósito: só corta no marcador do canal final (delimitado `<|channel|>final<|message|>`
// ou na forma colapsada `assistantfinal` — quando o gateway removeu os `<|...|>` mas concatenou os nomes).
// Não tenta adivinhar prosa de análise SEM marcador GRUDADA no meio de uma linha (evita destruir
// conteúdo legítimo do usuário/código). A defesa PRIMÁRIA contra o vazamento same-line é o transporte
// NÃO-STREAMING dos one-shots (charter/blueprint/resumir), que isola o raciocínio em reasoning_content;
// este util é a rede de segurança (linhas iniciais isoladas de controle harmony conhecidas).

// Início do canal FINAL: com os delimitadores harmony, ou colapsado (sem espaço) — nunca aparece em
// conteúdo legítimo. NÃO casamos "assistant final" (com espaço), que poderia ocorrer em texto normal.
const FINAL_CHANNEL_RE = /<\|channel\|>\s*final\s*<\|message\|>|assistantfinal/gi;
// Tokens de controle harmony (<|start|>, <|end|>, <|return|>, <|channel|>, <|message|>, …).
const HARMONY_TOKEN_RE = /<\|[a-z_]+\|>/gi;

// Frases de CONTROLE do canal analysis que o gpt-oss às vezes vaza SEM marcador, como preâmbulo antes
// da resposta final (confirmado em campo: "Now final output is markdown string." / "Proceed." e, no
// teste vivo, "Provide 2 sentences." / "We need to output the purpose…"). Removidas SÓ quando aparecem
// como LINHAS INICIAIS ISOLADAS (dropHarmonyPreamble) — NUNCA cortamos prosa grudada no MEIO de uma
// linha: isso destruiria código legítimo (o vazamento same-line já é neutralizado a montante — os
// one-shots rodam em não-streaming, que isola o raciocínio; a geração de código isola por cercas).
// Os padrões são específicos de análise harmony (inglês, verbo de planejamento) e ancorados a ^...$:
// não casam um comentário de código ("# provide 2 args" começa com "#") nem uma seção pt-BR.
const HARMONY_PREAMBLE_LINE =
  /^(now\b.*\bfinal\s+output\b.*|the\s+final\s+(answer|output)\b.*|proceed[.!…]*|assistant(final|analysis|commentary)?|provide\s+\d+\s+sentences?[.!…]*|we\s+need\s+to\s+(output|produce|write|emit|craft)\b.*)$/i;

// Descarta linhas iniciais que sejam vazias, um "." solto, ou uma frase de controle harmony conhecida —
// até a 1ª linha de conteúdo real. O teto de 8 linhas DESCARTADAS NÃO VAZIAS é o guarda contra
// stripping exagerado (linhas em branco não contam: não são conteúdo e o vazamento real vem espaçado).
function dropHarmonyPreamble(text: string): string {
  const lines = text.split("\n");
  let i = 0;
  let dropped = 0;
  while (i < lines.length && dropped < 8) {
    const t = lines[i].trim();
    if (t === "") {
      i++;
      continue;
    }
    if (t === "." || HARMONY_PREAMBLE_LINE.test(t)) {
      i++;
      dropped++;
      continue;
    }
    break;
  }
  return lines.slice(i).join("\n");
}

export function stripHarmony(text: string): string {
  if (!text) return text;
  // Se houver o marcador do canal final, o conteúdo real é o que vem DEPOIS do ÚLTIMO marcador (todo o
  // resto antes é raciocínio/análise vazado). Sem marcador, mantém o texto (só remove tokens/preâmbulo).
  const re = new RegExp(FINAL_CHANNEL_RE.source, "gi");
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(text); m; m = re.exec(text)) last = m;
  const body = (last ? text.slice(last.index + last[0].length) : text).replace(HARMONY_TOKEN_RE, "");
  // O preâmbulo heurístico SÓ é removido quando NÃO há marcador: com marcador, tudo após ele é, por
  // definição, o canal final — prosa legítima começando com "The final output …" seria destruída.
  return (last ? body : dropHarmonyPreamble(body)).trim();
}

// ---- Costura de geração continuada ----------------------------------------------------------

// Sobreposição mínima para o corte de repetição da costura: o modelo às vezes REPETE o que já
// escreveu na continuação (apesar da instrução "não repita") — do rabo da rodada anterior até a
// seção INTEIRA desde o início. Sobreposição exata >= 20 chars é assinatura de repetição, não
// coincidência; abaixo disso não cortamos (bullets parecidos poderiam casar por acaso).
const MIN_STITCH_OVERLAP = 20;

// Maior sufixo de `acc` que é prefixo de `next`, em tempo LINEAR (prefix-function/KMP sobre
// next[0..w) + separador + cauda de acc). As partes costuradas são rodadas TRUNCADAS no max_tokens
// (dezenas de milhares de chars): a busca ingênua O(n²), com um slice alocado por iteração,
// travaria o host da extensão. O separador \u0000 não ocorre em texto de modelo — impede um
// casamento atravessar a fronteira entre as duas metades.
function longestStitchOverlap(acc: string, next: string): number {
  const w = Math.min(acc.length, next.length);
  if (!w) return 0;
  const s = next.slice(0, w) + "\u0000" + acc.slice(acc.length - w);
  const pi = new Int32Array(s.length);
  for (let i = 1; i < s.length; i++) {
    let k = pi[i - 1];
    while (k > 0 && s[i] !== s[k]) k = pi[k - 1];
    if (s[i] === s[k]) k++;
    pi[i] = k;
  }
  return pi[s.length - 1];
}

// Corpo do canal final SEM o trim de extractFinalChannel: na costura, o trim destruiria o
// whitespace do ponto exato do corte (ex.: rodada terminando "…dose\n" + "- próximo" colaria
// o bullet na linha anterior). null quando não há marcador.
function finalChannelBody(text: string): string | null {
  const re = new RegExp(FINAL_CHANNEL_RE.source, "gi");
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(text); m; m = re.exec(text)) last = m;
  if (!last) return null;
  return text.slice(last.index + last[0].length).replace(HARMONY_TOKEN_RE, "");
}

// A 1ª linha NÃO VAZIA do texto é uma frase de controle harmony? Gate do dropHarmonyPreamble por
// parte: aplicá-lo incondicionalmente comeria o whitespace legítimo do início de uma continuação
// limpa (ex.: "\n- próximo bullet" perderia a quebra e colaria no rabo anterior).
function hasLeadingPreamble(text: string): boolean {
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    return t === "." || HARMONY_PREAMBLE_LINE.test(t);
  }
  return false;
}

// Junta as partes de uma geração CONTINUADA (resposta cortada por max_tokens + rodadas de
// continuação "siga de onde parou"). Saneamento POR PARTE antes de juntar:
// - stripHarmony no texto CONCATENADO pegaria só o que vem após o ÚLTIMO marcador — se cada rodada
//   vazar seu próprio "assistantfinal", as rodadas anteriores seriam descartadas;
// - o preâmbulo sem marcador ("Proceed." etc.) numa rodada >= 1 ficaria no MEIO do texto juntado,
//   onde o dropHarmonyPreamble do fim não alcança — por isso o gate hasLeadingPreamble por parte;
// - fora esses dois casos a parte entra CRUA (sem trim), preservando o ponto exato do corte.
// Para UMA parte o resultado é idêntico a stripHarmony (mesma regra do preâmbulo: com marcador na
// cabeça, tudo é canal final por definição e a heurística NÃO roda).
export function stitchHarmonyParts(parts: string[]): string {
  let acc = "";
  let headHasMarker = false;
  parts.forEach((raw, i) => {
    const final = finalChannelBody(raw);
    if (i === 0 && final !== null) headHasMarker = true;
    const p = final ?? (i > 0 && hasLeadingPreamble(raw) ? dropHarmonyPreamble(raw) : raw);
    if (!acc) {
      acc = p;
      return;
    }
    const n = longestStitchOverlap(acc, p);
    acc += n >= MIN_STITCH_OVERLAP ? p.slice(n) : p;
  });
  const body = acc.replace(HARMONY_TOKEN_RE, "");
  return (headHasMarker ? body : dropHarmonyPreamble(body)).trim();
}

// Devolve o conteúdo do canal final SÓ se o marcador harmony existir no texto (senão null).
// Fallback CONSERVADOR para quando o gateway roteia a resposta inteira para `reasoning_content`
// (gpt-oss sem canal final isolado): o raciocínio bruto NÃO é resposta — mas, se ele contém o
// marcador do canal final, o que vem depois do ÚLTIMO marcador é a resposta final real.
export function extractFinalChannel(text: string): string | null {
  if (!text) return null;
  const re = new RegExp(FINAL_CHANNEL_RE.source, "gi");
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(text); m; m = re.exec(text)) last = m;
  if (!last) return null;
  return text.slice(last.index + last[0].length).replace(HARMONY_TOKEN_RE, "").trim();
}
