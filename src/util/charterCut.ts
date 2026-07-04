// Heurística de "corte sem sinal" para TEXTO LIVRE do charter. O gpt-oss/HubGPU às vezes corta a
// resposta por limite de tokens mas reporta finish_reason="stop" em vez de "length" (reproduzido ao
// vivo) — sem o sinal, a continuação automática do charter (que é gated em length) não dispararia.
//
// Este predicado é o REFORÇO para esse caso: consultado SÓ quando NÃO houve o sinal de length, sobre o
// texto acumulado. É CONSERVADOR por construção — só dispara em sinais que NÃO ocorrem no fim de uma
// seção bem-formada. Listas de requisitos (RF-01…RF-15) sem pontuação final são NORMAIS e não disparam.
// Puro/testável; sem dependências de runtime.

// Palavras "de ligação" (preposições/conjunções/artigos) em pt-BR de DUAS OU MAIS letras, TODAS
// minúsculas, que NÃO fecham uma frase nem um item de lista. Uma linha terminando numa delas está quase
// certamente cortada no meio ("…para toda a lógica de", "…alertas personalizados para").
//
// Deliberadamente EXCLUÍDAS (revisão adversarial — eram falsos positivos):
//  - palavras de UMA letra ("a"/"o"/"e"): colidem com rótulos comuns ("anexo A", "item o", "nota A")
//    e a checagem minúscula não basta ("A" maiúsculo já não casa, mas "a" minúsculo de rótulo casaria);
//  - palavras inglesas ("on"/"in"/"to"/"of"/"or"…): "Modo standby: on", "Feature flag: on" são valores
//    de configuração legítimos, não preposição pendurada; o vazamento em inglês é raro e o sinal
//    PRIMÁRIO (finish_reason=length) o cobre.
// Cortes que terminam nessas exceções são raros e, quando reais, quase sempre vêm com o sinal de length.
const DANGLING_WORDS = new Set([
  "de", "da", "do", "das", "dos", "para", "por", "com", "sem", "em", "no", "na", "nos", "nas",
  "ao", "aos", "num", "numa", "pelo", "pela", "pelos", "pelas", "sob", "sobre", "entre",
  "até", "desde", "após", "ante", "perante", "contra",
  "ou", "mas", "nem", "que", "se", "como", "quando", "onde", "porque", "pois", "então",
  "as", "os", "um", "uma", "uns", "umas",
]);

export function charterProbablyCut(text: string): boolean {
  const lines = text.split("\n");
  // última linha NÃO-vazia (espaços/quebras finais não são corte)
  let i = lines.length - 1;
  while (i >= 0 && lines[i].trim() === "") i--;
  if (i < 0) return false;
  const last = lines[i].replace(/\s+$/, "");

  // (1) hífen de quebra silábica pendurado no fim ("…redução de custos-") — corte inequívoco, em
  //     qualquer tipo de linha (bullet, prosa ou heading).
  if (/[A-Za-zÀ-ÿ]-$/.test(last)) return true;

  // (2) termina numa palavra de ligação MINÚSCULA de ≥2 letras (preposição/conjunção/artigo) — não
  //     fecha frase nem item. A classe de caracteres [a-zà-ÿ] casa só MINÚSCULAS (rótulos como "A",
  //     "UTC", "API" têm maiúsculas → não casam); {2,} exclui as ambíguas de 1 letra. Pontuação após
  //     as letras (ex.: "…de.") impede o casamento no fim → fim bem-formado não dispara.
  const m = last.match(/([a-zà-ÿ]{2,})\s*$/);
  if (m && DANGLING_WORDS.has(m[1])) return true;

  return false; // DEFAULT CONSERVADOR: sem sinal FORTE, não é corte (fim bem-formado ou ambíguo).
}
