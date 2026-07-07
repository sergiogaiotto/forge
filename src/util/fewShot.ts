// Few-shot vivo (P1): constrói um turno de ASSISTENTE COMPACTO a partir do texto GERADO, para empilhar no
// histórico do host. Sem isto, o histórico só ganha o stub "Apliquei em X" e, num turno seguinte, o modelo
// NÃO vê seu próprio output no protocolo forge-file — tendendo a reverter para cerca comum (o sintoma
// copiar/colar da auditoria). O turno preserva os CABEÇALHOS forge-file (path=) e um trecho do corpo (teto
// por bloco + teto total), o bastante para reforçar o FORMATO sem inchar o orçamento de contexto do
// ContextAssembler. Retorna null quando o texto NÃO tem blocos forge-file — nesse caso não há few-shot a
// reforçar (e reforçar um formato errado seria contraproducente). PURO/testável.
import { parseFileBlocks } from "./fileBlocks";
import { FORGE_FENCE, FORGE_FILE_BLOCK_LANG } from "../shared/protocol";

export function buildFewShotTurn(generated: string, opts?: { maxBodyLines?: number; maxBodyChars?: number; maxTotalChars?: number }): string | null {
  const blocks = parseFileBlocks(generated ?? "");
  if (blocks.length === 0) return null; // sem forge-file → nada a reforçar
  const maxBodyLines = opts?.maxBodyLines ?? 30;
  const maxBodyChars = opts?.maxBodyChars ?? 1500;
  const maxTotalChars = opts?.maxTotalChars ?? 4000;

  const rendered: string[] = [];
  let total = 0;
  let omitted = 0;
  for (const b of blocks) {
    const lines = (b.content ?? "").split("\n");
    let body =
      lines.length > maxBodyLines
        ? [...lines.slice(0, maxBodyLines), `… (${lines.length - maxBodyLines} linha(s) omitida(s))`].join("\n")
        : b.content ?? "";
    // Teto de CARACTERES por corpo — vale INCLUSIVE no 1º bloco (que sempre entra). Sem isto, uma única
    // linha longa (data URI base64, JSON minificado, SVG inline) furaria o maxTotalChars e incharia o
    // contexto, empurrando trocas úteis pra fora do orçamento do ContextAssembler (achado da revisão).
    const bodyCap = Math.min(maxBodyChars, maxTotalChars);
    if (body.length > bodyCap) body = body.slice(0, bodyCap) + "\n… (corpo truncado)";
    let piece = `${FORGE_FENCE}${FORGE_FILE_BLOCK_LANG} path=${b.path}\n${body}\n${FORGE_FENCE}`;
    // Rede final sobre o PIECE INTEIRO — inclui o cabeçalho/path, que NÃO passa pelo bodyCap. Sem isto, um
    // path patológico (parseFileBlocks aceita token corrido arbitrário) furaria o teto e incharia o contexto
    // (achado da revisão). O few-shot é reforço de FORMATO no histórico do host (nunca é re-parseado como
    // proposta), então cortar aqui só encurta o exemplo — sem perda de dado. Garante o 1º bloco ≤ teto.
    if (piece.length > maxTotalChars) piece = piece.slice(0, maxTotalChars) + "…";
    // Corta por BLOCO (nunca no meio de um bloco, que deixaria a cerca aberta). Sempre inclui ao menos 1.
    if (rendered.length > 0 && total + piece.length > maxTotalChars) {
      omitted++;
      continue;
    }
    rendered.push(piece);
    total += piece.length;
  }
  if (omitted > 0) rendered.push(`… (${omitted} bloco(s) omitido(s) por tamanho)`);
  return rendered.join("\n\n");
}
