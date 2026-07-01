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

export function stripHarmony(text: string): string {
  if (!text) return text;
  // Se houver o marcador do canal final, o conteúdo real é o que vem DEPOIS do ÚLTIMO marcador (todo o
  // resto antes é raciocínio/análise vazado). Sem marcador, mantém o texto (só remove tokens residuais).
  const re = new RegExp(FINAL_CHANNEL_RE.source, "gi");
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(text); m; m = re.exec(text)) last = m;
  const body = last ? text.slice(last.index + last[0].length) : text;
  return body.replace(HARMONY_TOKEN_RE, "").trim();
}
