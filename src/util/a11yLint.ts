// Linter de ACESSIBILIDADE (a11y) PURO-TS para a saída de frontend gerada (#06). Motivação: a11y era o
// ÚNICO domínio sem MOTOR — SQL tem 16 regras, Python tem bandit/ruff/mypy, TS tem tsc, mas o frontend
// gerado era 100% prompt: o isFrontendRequest (#168) só FORÇA a skill de a11y no prompt, sem validar a
// SAÍDA. O modelo pode ignorar a skill e ninguém pega (a classe F-15/F-16: placeholder no lugar de rótulo).
//
// Heurístico e PURO (sem parser/DOM, sem deps): casa tags de abertura por regex. É ADVISORY (nunca bloqueia
// o Aplicar), então a postura é CONSERVADORA — melhor perder um caso do que gritar um falso-positivo:
// - um spread JSX ({...props}) numa tag é tratado como "pode ter o atributo" → não acusa (evita FP em
//   <input {...register("x")} /> ou <button {...props}>);
// - só varre arquivos de frontend (html/jsx/tsx/vue/svelte).
// As 4 regras (o pedido do survey): img sem alt, html sem lang, botão-ícone sem nome, input sem rótulo.

export interface A11yFinding {
  path: string;
  line: number;
  rule: "img-alt" | "html-lang" | "button-name" | "input-label";
  message: string;
}

const FRONTEND_RE = /\.(html?|jsx|tsx|vue|svelte)$/i;
const MAX_FINDINGS = 50; // teto por varredura (advisory não deve inundar)

// Controles de formulário que NÃO precisam de rótulo textual (não recebem entrada livre do usuário).
const UNLABELED_INPUT_TYPES = new Set(["hidden", "submit", "button", "reset", "image"]);

function lineOf(content: string, idx: number): number {
  let line = 1;
  for (let i = 0; i < idx && i < content.length; i++) if (content.charCodeAt(i) === 10) line++;
  return line;
}

// Um spread JSX na tag ({...x}) esconde atributos que não conseguimos ver → tratamos como "rotulável" p/ não
// acusar falso. Fora isso, casa `attr=`, `attr={`, `attr "` (booleano) na string da tag de abertura.
function hasSpread(openTag: string): boolean {
  return /\{\s*\.\.\./.test(openTag);
}
function tagHasAttr(openTag: string, attr: string): boolean {
  if (hasSpread(openTag)) return true;
  return new RegExp(`(^|[\\s{])${attr}(\\s*=|[\\s/>]|$)`, "i").test(openTag);
}
function attrValue(openTag: string, attr: string): string | undefined {
  return new RegExp(`(?:^|[\\s{])${attr}\\s*=\\s*["']([^"']*)["']`, "i").exec(openTag)?.[1];
}

/** Varre os arquivos de FRONTEND e devolve achados de a11y (advisory). Puro/testável. */
export function scanA11y(files: { path: string; content: string }[]): A11yFinding[] {
  const out: A11yFinding[] = [];
  const add = (f: A11yFinding): void => {
    if (out.length < MAX_FINDINGS) out.push(f);
  };
  for (const file of files) {
    if (!FRONTEND_RE.test(file.path) || out.length >= MAX_FINDINGS) continue;
    const c = file.content ?? "";

    // 1) <img> sem alt (alt="" explícito é VÁLIDO — imagem decorativa; só a AUSÊNCIA do atributo acusa).
    for (const m of c.matchAll(/<img\b[^>]*?\/?>/gi)) {
      if (!tagHasAttr(m[0], "alt")) add({ path: file.path, line: lineOf(c, m.index ?? 0), rule: "img-alt", message: '<img> sem atributo alt (use alt="" se for decorativa; senão descreva a imagem)' });
    }

    // 2) <html> sem lang (leitor de tela precisa do idioma; um por documento).
    for (const m of c.matchAll(/<html\b[^>]*>/gi)) {
      if (!tagHasAttr(m[0], "lang")) add({ path: file.path, line: lineOf(c, m.index ?? 0), rule: "html-lang", message: "<html> sem atributo lang (ex.: lang=\"pt-BR\") — o leitor de tela precisa do idioma" });
    }

    // 3) <button> só com ícone e SEM nome acessível: conteúdo sem TEXTO nem expressão {…} (só <svg>/<i>…),
    //    e sem aria-label/aria-labelledby/title. Manter {…} como "tem nome" evita FP em <button>{t("save")}</button>.
    for (const m of c.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
      const attrs = m[1];
      if (tagHasAttr(attrs, "aria-label") || tagHasAttr(attrs, "aria-labelledby") || tagHasAttr(attrs, "title")) continue;
      const innerNoTags = m[2].replace(/<[^>]+>/g, "").trim(); // remove tags aninhadas; PRESERVA texto e {…}
      if (innerNoTags.length > 0) continue; // sobrou texto ou expressão JSX → provável nome acessível
      add({ path: file.path, line: lineOf(c, m.index ?? 0), rule: "button-name", message: "<button> só com ícone e sem nome acessível (adicione aria-label ou um texto visível)" });
    }

    // 4) <input> de texto sem RÓTULO: sem aria-label/labelledby/title, sem <label for=id> casando o id, e sem
    //    um <label> imediatamente antes (janela curta — cobre o label adjacente/envolvente). placeholder NÃO
    //    conta como rótulo (a classe F-15/F-16). Conservador: só acusa quando há placeholder (sinaliza campo
    //    de entrada) — reduz FP em inputs rotulados por composição cross-arquivo que não enxergamos.
    const labelFor = new Set<string>();
    for (const lm of c.matchAll(/<label\b[^>]*\b(?:for|htmlFor)\s*=\s*["'{]?\s*([\w-]+)/gi)) labelFor.add(lm[1]);
    for (const m of c.matchAll(/<input\b[^>]*?\/?>/gi)) {
      const tag = m[0];
      const type = (attrValue(tag, "type") ?? "").toLowerCase();
      if (UNLABELED_INPUT_TYPES.has(type)) continue;
      if (!tagHasAttr(tag, "placeholder")) continue; // sinal de campo de entrada; sem ele, alto risco de FP
      if (tagHasAttr(tag, "aria-label") || tagHasAttr(tag, "aria-labelledby") || tagHasAttr(tag, "title")) continue;
      const id = attrValue(tag, "id");
      if (id && labelFor.has(id)) continue; // tem <label for=id> casando
      const before = c.slice(Math.max(0, (m.index ?? 0) - 80), m.index ?? 0);
      if (/<label\b/i.test(before)) continue; // label adjacente/envolvente logo antes → provável rótulo
      add({ path: file.path, line: lineOf(c, m.index ?? 0), rule: "input-label", message: "<input> com placeholder mas sem rótulo acessível (placeholder NÃO é rótulo — associe um <label for> ou aria-label)" });
    }
  }
  return out;
}
