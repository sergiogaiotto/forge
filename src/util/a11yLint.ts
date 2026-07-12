// Linter de ACESSIBILIDADE (a11y) PURO-TS para a saída de frontend gerada (#06). Motivação: a11y era o
// ÚNICO domínio sem MOTOR — SQL tem 16 regras, Python tem bandit/ruff/mypy, TS tem tsc, mas o frontend
// gerado era 100% prompt: o isFrontendRequest (#168) só FORÇA a skill de a11y no prompt, sem validar a
// SAÍDA. O modelo pode ignorar a skill e ninguém pega (a classe F-15/F-16: placeholder no lugar de rótulo).
//
// Heurístico e PURO (sem parser/DOM, sem deps). É ADVISORY (nunca bloqueia o Aplicar), então a postura é
// CONSERVADORA — melhor perder um caso do que gritar um falso-positivo sobre markup acessível legítimo:
// - a extração de tag é ROBUSTA a JSX (scanner char-a-char que rastreia {} e aspas): um '>' dentro de uma
//   expressão {() => ...} ou de um valor "a>b" NÃO termina a tag — um regex [^>]* truncava no 1º '>' e
//   gerava 6 falsos-positivos/negativos (achado da revisão adversarial);
// - um spread JSX ({...props}) numa tag é tratado como "pode ter o atributo" → não acusa;
// - o nome acessível de um <button> pode vir de um DESCENDENTE (<img alt>, aria-label) — a computação de
//   nome do W3C deriva do subtree, então não acusamos botão-imagem;
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

// Extrai as tags de ABERTURA <name ...> de forma robusta a JSX. O '>' que fecha a tag é o primeiro em
// profundidade-0 de chaves E fora de aspas — assim um '>' dentro de {() => x}, {a > b} ou "data>x" não
// corta a tag no meio (a fragilidade do [^>]* que a revisão pegou). Devolve a string COMPLETA da tag + índice.
function findOpenTags(content: string, name: string): { tag: string; index: number }[] {
  const out: { tag: string; index: number }[] = [];
  const re = new RegExp(`<${name}\\b`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    const start = m.index;
    let i = start + m[0].length;
    let depth = 0;
    let quote = "";
    for (; i < content.length; i++) {
      const ch = content[i];
      if (quote) {
        if (ch === quote) quote = "";
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if (ch === "{") depth++;
      else if (ch === "}") depth = Math.max(0, depth - 1);
      else if (ch === ">" && depth === 0) {
        i++;
        break;
      }
    }
    out.push({ tag: content.slice(start, i), index: start });
    re.lastIndex = i; // retoma DEPOIS desta tag (não re-casa o miolo)
  }
  return out;
}

// Um spread JSX na tag ({...x}) esconde atributos que não vemos → tratamos como "rotulável" p/ não acusar falso.
function hasSpread(openTag: string): boolean {
  return /\{\s*\.\.\./.test(openTag);
}
// Exige `attr=` — todos os atributos que checamos são de VALOR (alt/lang/aria-label/placeholder/title), nunca
// booleanos. Sem o `=`, a palavra do atributo DENTRO do valor de outro (ex.: title="the alt text") casaria e
// suprimiria o aviso por engano (falso-negativo confirmado na revisão).
function tagHasAttr(openTag: string, attr: string): boolean {
  if (hasSpread(openTag)) return true;
  return new RegExp(`(^|[\\s{])${attr}\\s*=`, "i").test(openTag);
}
function attrValue(openTag: string, attr: string): string | undefined {
  return new RegExp(`(?:^|[\\s{])${attr}\\s*=\\s*["']([^"']*)["']`, "i").exec(openTag)?.[1];
}

// O <input> está DENTRO de um <label> ancestral (associação implícita, válida)? Length-INDEPENDENTE: há um
// `<label` aberto depois do último `</label>` antes do input? (A janela fixa de 80 chars perdia o label
// envolvente com markup intermediário — achado da revisão.)
function insideOpenLabel(content: string, idx: number): boolean {
  const before = content.slice(0, idx).toLowerCase();
  const lastOpen = before.lastIndexOf("<label");
  return lastOpen >= 0 && lastOpen > before.lastIndexOf("</label>");
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
    for (const t of findOpenTags(c, "img")) {
      if (!tagHasAttr(t.tag, "alt")) add({ path: file.path, line: lineOf(c, t.index), rule: "img-alt", message: '<img> sem atributo alt (use alt="" se for decorativa; senão descreva a imagem)' });
    }

    // 2) <html> sem lang (o leitor de tela precisa do idioma; um por documento).
    for (const t of findOpenTags(c, "html")) {
      if (!tagHasAttr(t.tag, "lang")) add({ path: file.path, line: lineOf(c, t.index), rule: "html-lang", message: '<html> sem atributo lang (ex.: lang="pt-BR") — o leitor de tela precisa do idioma' });
    }

    // 3) <button> só com ícone e SEM nome acessível. O nome pode vir do próprio botão (aria-label/title) OU de
    //    um DESCENDENTE (<img alt="…"> não-vazio, ou filho com aria-label/title — a computação de nome do W3C
    //    deriva do subtree). Só acusa quando não há NENHUM texto/expressão {…} e nenhum nome no subtree.
    const openButtons = findOpenTags(c, "button");
    for (const b of openButtons) {
      if (/\/>\s*$/.test(b.tag)) continue; // <button/> self-closing (raríssimo) — sem miolo
      if (tagHasAttr(b.tag, "aria-label") || tagHasAttr(b.tag, "aria-labelledby") || tagHasAttr(b.tag, "title")) continue;
      const openEnd = b.index + b.tag.length;
      const close = c.toLowerCase().indexOf("</button>", openEnd);
      const inner = close >= 0 ? c.slice(openEnd, close) : c.slice(openEnd);
      // Nome vindo do subtree: <img alt NÃO-vazio> (decorativo alt="" ainda acusa), ou aria-label/title num filho.
      if (/<img\b[^>]*\balt\s*=\s*["'][^"']+["']/i.test(inner) || /\b(?:aria-label|aria-labelledby|title)\s*=/i.test(inner)) continue;
      const innerNoTags = inner.replace(/<[^>]+>/g, "").trim(); // remove tags aninhadas; PRESERVA texto e {…}
      if (innerNoTags.length > 0) continue; // sobrou texto ou expressão JSX → provável nome acessível
      add({ path: file.path, line: lineOf(c, b.index), rule: "button-name", message: "<button> só com ícone e sem nome acessível (adicione aria-label ou um texto visível)" });
    }

    // 4) <input> de texto com placeholder mas SEM rótulo: sem aria-label/labelledby/title, sem <label for=id>
    //    casando o id, e sem um <label> ANCESTRAL (envolvente). placeholder NÃO conta como rótulo (F-15/F-16).
    //    Conservador: só acusa quando há placeholder (sinal de campo de entrada) — reduz FP em inputs rotulados
    //    por composição cross-arquivo que não enxergamos.
    const labelFor = new Set<string>();
    for (const t of findOpenTags(c, "label")) {
      const f = attrValue(t.tag, "for") ?? attrValue(t.tag, "htmlFor");
      if (f) labelFor.add(f);
    }
    for (const t of findOpenTags(c, "input")) {
      const tag = t.tag;
      const type = (attrValue(tag, "type") ?? "").toLowerCase();
      if (UNLABELED_INPUT_TYPES.has(type)) continue;
      if (!tagHasAttr(tag, "placeholder")) continue; // sem placeholder → alto risco de FP → conservador, não acusa
      if (tagHasAttr(tag, "aria-label") || tagHasAttr(tag, "aria-labelledby") || tagHasAttr(tag, "title")) continue;
      const id = attrValue(tag, "id");
      if (id && labelFor.has(id)) continue; // tem <label for=id> casando
      if (insideOpenLabel(c, t.index)) continue; // <label> ancestral envolvente (independe da distância)
      add({ path: file.path, line: lineOf(c, t.index), rule: "input-label", message: "<input> com placeholder mas sem rótulo acessível (placeholder NÃO é rótulo — associe um <label for> ou aria-label)" });
    }
  }
  return out;
}
