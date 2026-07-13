// SAST PURO-TS para a saída TypeScript/JavaScript gerada — a PARIDADE de segurança que faltava fora do
// Python (o bandit é Python-only; TS não tinha NENHUMA cobertura de segurança no gate). Heurístico e PURO
// (sem parser/AST, sem deps), no molde do a11yLint. Espelha as classes que o bandit BLOQUEIA (execução de
// código / injeção de shell — B102/B307/B602/B605/B609) e mantém segredo-hardcoded + XSS como ADVISORY
// (como o bandit trata B105/B106). O bloqueio exige a MESMA precisão do bandit: só padrões de altíssima
// confiança, e SEMPRE após validar contra output real (a lição repetida de a11yLint/ruff/redação).
//
// Anti-FP: varre a versão SEM COMENTÁRIOS E SEM STRINGS '...'/"..." (a fonte dominante de falso-positivo de
// um pattern-scan — um `// evite eval()` ou `"use eval"` NÃO deve acusar). Preserva posições (blank in-place).

export type SastSev = "blocking" | "advisory";
export type SastRule = "code-exec" | "shell-exec" | "hardcoded-secret" | "xss";

export interface SastFinding {
  path: string;
  line: number;
  rule: SastRule;
  severity: SastSev;
  message: string;
}

const CODE_RE = /\.[cm]?[jt]sx?$/i; // .js/.jsx/.ts/.tsx/.cjs/.mjs/.cts/.mts
const MAX_FINDINGS = 50;
// Nomes usuais do binding de child_process — um `X.exec` só é shell quando X é um destes (senão é db.exec/re.exec/etc.).
const CP_ALIASES = new Set(["cp", "childProcess", "child_process", "cproc", "proc", "childproc"]);

function lineOf(content: string, idx: number): number {
  let line = 1;
  for (let i = 0; i < idx && i < content.length; i++) if (content.charCodeAt(i) === 10) line++;
  return line;
}

// Apaga comentários (// e /* */), o CONTEÚDO de strings '...'/"..." E o TEXTO de template literals `...`
// (mantendo as ${…} INTERPOLAÇÕES, que são CÓDIGO — ex.: `${eval(x)}` ainda é detectado). Preserva posições
// e quebras de linha. Sem apagar o texto de template, um `nunca chame eval()` numa string de prompt/erro/doc
// gerada acusava — o FP dominante que a revisão pegou (o gate roda sobre código GERADO, onde isso é comum).
// Puro; nunca lança. Casos ambíguos (aninhamento em ${…}) erram para o lado SEGURO (apagar demais = perder um
// achado, nunca um falso-positivo).
export function codeOnly(src: string): string {
  const s = src ?? "";
  const out = s.split("");
  const n = s.length;
  const blank = (a: number, b: number): void => {
    for (let k = a; k < b && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < n) {
    const ch = s[i];
    const nx = s[i + 1];
    if (ch === "/" && nx === "/") {
      let j = i + 2;
      while (j < n && s[j] !== "\n") j++;
      blank(i, j);
      i = j;
    } else if (ch === "/" && nx === "*") {
      let j = i + 2;
      while (j < n && !(s[j] === "*" && s[j + 1] === "/")) j++;
      j = Math.min(n, j + 2);
      blank(i, j);
      i = j;
    } else if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n && s[j] !== ch && s[j] !== "\n") {
        if (s[j] === "\\") j++;
        j++;
      }
      blank(i + 1, j); // apaga o miolo; mantém as aspas
      i = j + 1;
    } else if (ch === "`") {
      // Template literal: apaga os RUNS de texto, PRESERVA as ${…} (código). Rastreia a profundidade de {}.
      let j = i + 1;
      let textStart = j;
      while (j < n && s[j] !== "`") {
        if (s[j] === "\\") {
          j += 2;
          continue;
        }
        if (s[j] === "$" && s[j + 1] === "{") {
          blank(textStart, j); // apaga o texto ANTES do ${
          let depth = 1;
          j += 2;
          while (j < n && depth > 0) {
            if (s[j] === "{") depth++;
            else if (s[j] === "}") depth--;
            j++;
          }
          textStart = j; // retoma o texto DEPOIS do }
        } else {
          j++;
        }
      }
      blank(textStart, j); // apaga o run de texto final
      i = j + 1; // depois da crase de fechamento
    } else {
      i++;
    }
  }
  return out.join("");
}

// Índice do ')' que fecha o '(' em `open` (equilíbrio de parênteses). Bounded por `max` (args gigantes não
// estouram). -1 se não fechar.
function matchParen(code: string, open: number, max = 600): number {
  let depth = 0;
  const end = Math.min(code.length, open + max);
  for (let i = open; i < end; i++) {
    if (code[i] === "(") depth++;
    else if (code[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

// PRIMEIRO argumento da chamada (do '(' até a 1ª vírgula de TOPO, ignorando aninhamento de ()[]{})— o COMANDO.
// Crucial: a injeção está no comando, NÃO nos args seguintes (options, callback). Sem isto, um `${…}` no corpo
// do callback (ex.: exec(cmd, opts, (e,out)=>`${out}`)) disparava falso-positivo (FP pego na validação do repo).
function firstArg(code: string, open: number, max = 600): string {
  let depth = 0;
  const end = Math.min(code.length, open + max);
  for (let i = open; i < end; i++) {
    const ch = code[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (--depth === 0) return code.slice(open + 1, i);
    } else if (ch === "," && depth === 1) return code.slice(open + 1, i);
  }
  return code.slice(open + 1, end);
}

// Comando DINÂMICO = concatenação (`+`) ou template (`${`) — comando montado com input (injeção). Um literal
// estático (execSync("ls -la")) NÃO é dinâmico. `shell: true` habilita a interpretação por shell.
function hasDynamicCmd(argRegion: string): boolean {
  return /\+/.test(argRegion) || /\$\{/.test(argRegion);
}
function hasShellTrue(argRegion: string): boolean {
  return /\bshell\s*:\s*true\b/.test(argRegion);
}

/** Varre arquivos TS/JS e devolve achados de SAST. Puro/testável. `code` é a versão sem comentários/strings. */
export function scanSast(files: { path: string; content: string }[]): SastFinding[] {
  const out: SastFinding[] = [];
  const add = (f: SastFinding): void => {
    if (out.length < MAX_FINDINGS) out.push(f);
  };
  for (const file of files) {
    if (!CODE_RE.test(file.path) || out.length >= MAX_FINDINGS) continue;
    const raw = file.content ?? "";
    const code = codeOnly(raw);
    // IMPORT REAL de child_process (não um substring cru — que a palavra num comentário/string ligaria, um FP
    // da revisão). Checado no RAW porque o codeOnly apaga o path (que é string).
    const importsChildProc = /(?:from\s*|require\(\s*)['"](?:node:)?child_process['"]/.test(raw);

    // 1) EXECUÇÃO DE CÓDIGO (B102/B307): eval(...) e new Function(...). Comentários/strings/texto-de-template
    //    já foram neutralizados. O lookbehind (?<![.\w$]) EXCLUI chamadas de MEMBRO/método homônimas —
    //    api.eval(), page.$eval() (Puppeteer/Playwright), math.eval() — que NÃO são o eval global (achado da
    //    revisão). `\beval` não casaria "retrieval("; o lookbehind cobre "$eval"/".eval".
    for (const re of [/(?<![.\w$])eval\s*\(/g, /(?<![.\w$])new\s+Function\s*\(/g]) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(code))) {
        add({ path: file.path, line: lineOf(code, m.index), rule: "code-exec", severity: "blocking", message: "execução dinâmica de código (eval/new Function) — evite; use um dispatch explícito" });
      }
    }

    // 2) INJEÇÃO DE SHELL (BLOQUEIA — B602/B605/B609). O perigo é o SHELL, não a concatenação em si:
    //    - exec/execSync SEMPRE rodam via shell (/bin/sh -c cmd) → comando DINÂMICO = injeção.
    //    - spawn/spawnSync/execFile/execFileSync passam args como ARRAY, SEM shell → SEGUROS (concatenação nos
    //      args é ok); só bloqueiam com `shell: true` (habilita o shell). Isto evita marcar a forma RECOMENDADA
    //      (execFile/spawn com array) como vulnerável — o FP que o próprio código do repo expôs na validação.
    //    Só é child_process quando: chamada CRUA (import real de child_process) OU o receiver é um alias
    //    conhecido (cp.exec). Um receiver QUALQUER — db.exec (better-sqlite3), re.exec (RegExp), stmt.exec —
    //    NÃO é shell → ignora (o FP largo que a revisão pegou).
    const shellRe = /(?:(\w+)\s*\.\s*)?(execSync|spawnSync|execFileSync|execFile|spawn|exec)\s*\(/g;
    let sm: RegExpExecArray | null;
    while ((sm = shellRe.exec(code))) {
      const recv = sm[1];
      const fn = sm[2];
      if (recv ? !CP_ALIASES.has(recv) : !importsChildProc) continue;
      const open = sm.index + sm[0].length - 1;
      const close = matchParen(code, open);
      const argRegion = close > open ? code.slice(open + 1, close) : code.slice(open + 1, open + 400);
      const isShellFn = fn === "exec" || fn === "execSync";
      // dynamicCmd só no COMANDO (1º arg); shell:true em QUALQUER arg (fica no objeto de options).
      if (isShellFn && hasDynamicCmd(firstArg(code, open))) {
        // shell + comando dinâmico = injeção clara (near-zero-FP; o repo teve ZERO) → BLOQUEIA.
        add({ path: file.path, line: lineOf(code, sm.index), rule: "shell-exec", severity: "blocking", message: `injeção de shell: ${fn}() com comando dinâmico (concatenação/template) — passe args como array (sem shell) e valide a entrada` });
      } else if (!isShellFn && hasShellTrue(argRegion)) {
        // spawn/execFile com shell:true é um smell, mas tem usos legítimos (rodar o comando de run do usuário)
        // e o bandit só o eleva a HIGH com comando dinâmico → ADVISORY (evita FP em código de run legítimo).
        add({ path: file.path, line: lineOf(code, sm.index), rule: "shell-exec", severity: "advisory", message: `${fn}() com shell:true — prefira args como array sem shell; com shell, valide/escape a entrada (risco de injeção)` });
      }
    }

    // 3) XSS (ADVISORY): dangerouslySetInnerHTML / .innerHTML = com valor dinâmico (concatenação/template).
    for (const m of code.matchAll(/\bdangerouslySetInnerHTML\b/g)) {
      add({ path: file.path, line: lineOf(code, m.index ?? 0), rule: "xss", severity: "advisory", message: "dangerouslySetInnerHTML — risco de XSS; sanitize o HTML (ex.: DOMPurify) ou renderize como texto" });
    }
    for (const m of code.matchAll(/\.innerHTML\s*=(?!=)\s*[^;\n]*(?:\+|\$\{)/g)) {
      // =(?!=) exige ATRIBUIÇÃO (não == / === de comparação — o FP que a revisão pegou)
      add({ path: file.path, line: lineOf(code, m.index ?? 0), rule: "xss", severity: "advisory", message: ".innerHTML com valor dinâmico — risco de XSS; use textContent ou sanitize" });
    }

    // 4) SEGREDO HARDCODED (ADVISORY): token de provedor por PREFIXO de altíssima precisão (prefixo + dígito),
    //    subconjunto curado dos detectores da redação. Advisory (como o B105/B106 do bandit). Varre o RAW (um
    //    segredo pode estar numa string — que é exatamente o problema). Unificar com a redação se promovido.
    const secretRes: [RegExp, string][] = [
      [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "AWS access key id"],
      [/\bsk-proj-[A-Za-z0-9]{16,120}/g, "OpenAI project key"],
      [/\bsk-ant-[A-Za-z0-9_-]{0,20}[0-9][A-Za-z0-9_-]{12,180}/g, "Anthropic key"],
      [/\bgithub_pat_[A-Za-z0-9_]{20,120}/g, "GitHub PAT"],
      [/\bgh[pousr]_[A-Za-z0-9]{20,120}/g, "GitHub token"],
      [/\bglpat-[A-Za-z0-9_-]{20,120}/g, "GitLab PAT"],
      [/\bxox[baprs]-[A-Za-z0-9-]{10,120}/g, "Slack token"],
      [/\bAIza[A-Za-z0-9_-]{30,45}/g, "Google API key"],
      [/\b[srp]k_(?:live|test)_[A-Za-z0-9]{10,120}/gi, "Stripe key"],
    ];
    for (const [re, kind] of secretRes) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(raw))) {
        add({ path: file.path, line: lineOf(raw, m.index), rule: "hardcoded-secret", severity: "advisory", message: `segredo hardcoded (${kind}) — mova para variável de ambiente / cofre; nunca versione credenciais` });
      }
    }
  }
  return out;
}

// Separa em BLOQUEANTES (só as classes blocking, no modo conservador — via a mesma allowlist de precisão do
// bandit) e ADVISORY (o resto, ou TUDO no modo advisory). Espelha splitSecurityFindings (banditParse.ts) —
// mesmo shape {path, errors[]} p/ o gate reusar TODO o downstream (blocked set, resumo, cartões).
export function splitSast(findings: SastFinding[], mode: "conservative" | "advisory"): { blocking: { path: string; errors: string[] }[]; advisories: string[] } {
  const blockingSet = new Set<SastFinding>(mode === "conservative" ? findings.filter((f) => f.severity === "blocking") : []);
  const byPath = new Map<string, string[]>();
  for (const f of findings) {
    if (!blockingSet.has(f)) continue;
    const arr = byPath.get(f.path) ?? [];
    arr.push(`SAST ${f.rule}, linha ${f.line}: ${f.message}`);
    byPath.set(f.path, arr);
  }
  const blocking = [...byPath].map(([path, errors]) => ({ path, errors })).sort((a, b) => a.path.localeCompare(b.path));
  const advisories = findings
    .filter((f) => !blockingSet.has(f))
    .map((f) => `${f.path}:${f.line} — SAST ${f.rule}: ${f.message}`)
    .sort();
  return { blocking, advisories };
}
