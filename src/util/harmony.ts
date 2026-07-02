// Saneamento do formato "harmony" do gpt-oss (openai/gpt-oss servido OpenAI-compatível, ex.: HubGPU).
// O gpt-oss estrutura a resposta em CANAIS (analysis/commentary/final). Quando o gateway NÃO isola o
// canal de raciocínio no campo `reasoning_content`, o texto de análise VAZA dentro de `delta.content`
// (ex.: "Now final output is markdown string. Proceed." antes da resposta) — poluindo tudo que consome
// o texto final: o Charter (o lixo aparece no campo) e o Blueprint (quebra o JSON → plano vazio).
//
// Este util extrai SÓ o conteúdo do canal FINAL e remove os tokens de controle harmony. Puro/testável.
// Conservador de propósito: só corta no marcador do canal final (delimitado `<|channel|>final<|message|>`
// ou na forma colapsada `assistantfinal` — quando o gateway removeu os `<|...|>` mas concatenou os nomes).
// Não tenta adivinhar prosa de análise SEM marcador (evita destruir conteúdo legítimo do usuário).

// Início do canal FINAL: com os delimitadores harmony, ou colapsado (sem espaço) — nunca aparece em
// conteúdo legítimo. NÃO casamos "assistant final" (com espaço), que poderia ocorrer em texto normal.
const FINAL_CHANNEL_RE = /<\|channel\|>\s*final\s*<\|message\|>|assistantfinal/gi;
// Tokens de controle harmony (<|start|>, <|end|>, <|return|>, <|channel|>, <|message|>, …).
const HARMONY_TOKEN_RE = /<\|[a-z_]+\|>/gi;

// Frases de CONTROLE do canal analysis que o gpt-oss às vezes vaza SEM marcador, como preâmbulo antes
// da resposta final (confirmado num project.md real: "Now final output is markdown string." / "Proceed.").
// Removidas SÓ quando aparecem como LINHAS INICIAIS isoladas — conservador, não casa prosa no meio.
const HARMONY_PREAMBLE_LINE =
  /^(now\b.*\bfinal\s+output\b.*|the\s+final\s+(answer|output)\b.*|proceed[.!…]*|assistant(final|analysis|commentary)?)$/i;

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
