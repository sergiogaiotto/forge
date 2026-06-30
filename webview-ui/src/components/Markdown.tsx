import React, { useEffect, useRef, useState } from "react";
import { Block, Inline, parseMarkdownBlocks } from "../markdown";
import { Icon } from "../icons";

// Renderiza a AST de markdown (ver ../markdown.ts) como nós React. Nunca usa HTML cru: cada nó é um
// elemento React, então não há superfície de XSS vinda do texto do modelo.

function renderInline(nodes: Inline[]): React.ReactNode {
  return nodes.map((n, i) => {
    switch (n.t) {
      case "text":
        return <React.Fragment key={i}>{n.v}</React.Fragment>;
      case "code":
        return (
          <code key={i} className="md-icode">
            {n.v}
          </code>
        );
      case "strong":
        return <strong key={i}>{renderInline(n.c)}</strong>;
      case "em":
        return <em key={i}>{renderInline(n.c)}</em>;
      case "link":
        return (
          <a key={i} href={n.href} target="_blank" rel="noreferrer noopener">
            {renderInline(n.c)}
          </a>
        );
    }
  });
}

// Box de código com cabeçalho (linguagem + copiar). É o "bloco estilizado" que faltava para as
// cercas markdown comuns (```python, ```bash) — antes elas caíam como texto cru no chat.
// `open` = cerca ainda chegando no streaming: não oferecemos "copiar" um trecho incompleto.
function CodeBox({ lang, code, open }: { lang: string; code: string; open: boolean }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(code).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => undefined
    );
  };
  return (
    <div className={open ? "md-code md-code-open" : "md-code"}>
      <div className="md-code-head">
        <span className="md-code-lang">
          <Icon name="code" size={12} /> {lang || "código"}
        </span>
        {open ? (
          <span className="md-code-progress">
            <Icon name="refresh" size={11} className="spin" /> gerando…
          </span>
        ) : (
          <button className="md-code-copy" onClick={copy} title="Copiar">
            <Icon name={copied ? "check" : "copy"} size={12} /> {copied ? "Copiado" : "Copiar"}
          </button>
        )}
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

// `trailing` é o cursor de digitação, injetado inline no fim do ÚLTIMO bloco (quando ele é texto),
// para o caret piscar colado à frase em construção em vez de cair numa linha solta sob o bloco.
function renderBlock(b: Block, key: number, trailing?: React.ReactNode): React.ReactNode {
  switch (b.t) {
    case "p":
      return (
        <p key={key} className="md-p">
          {renderInline(b.c)}
          {trailing}
        </p>
      );
    case "heading": {
      const Tag = `h${Math.min(Math.max(b.level, 1), 6)}` as keyof JSX.IntrinsicElements;
      return (
        <Tag key={key} className="md-h">
          {renderInline(b.c)}
          {trailing}
        </Tag>
      );
    }
    case "code":
      return <CodeBox key={key} lang={b.lang} code={b.v} open={b.open} />;
    case "list":
      return b.ordered ? (
        <ol key={key} className="md-list" start={b.start}>
          {b.items.map((it, j) => (
            <li key={j}>{renderInline(it)}</li>
          ))}
        </ol>
      ) : (
        <ul key={key} className="md-list">
          {b.items.map((it, j) => (
            <li key={j}>{renderInline(it)}</li>
          ))}
        </ul>
      );
    case "table":
      return (
        <div key={key} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {b.head.map((c, j) => (
                  <th key={j} style={b.align[j] ? { textAlign: b.align[j]! } : undefined}>
                    {renderInline(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => (
                    <td key={ci} style={b.align[ci] ? { textAlign: b.align[ci]! } : undefined}>
                      {renderInline(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "quote":
      return (
        <blockquote key={key} className="md-quote">
          {renderInline(b.c)}
          {trailing}
        </blockquote>
      );
    case "hr":
      return <hr key={key} className="md-hr" />;
  }
}

// Durante o streaming, o texto cresce a cada token e re-parsear o documento inteiro a cada delta é
// O(N²). Limitamos o re-parse a no máximo uma vez por janela (ms) enquanto o stream está ativo; ao
// terminar (ms=0) parseamos o texto final imediatamente.
function useThrottled(value: string, ms: number): string {
  const [v, setV] = useState(value);
  const lastRef = useRef(0);
  useEffect(() => {
    if (ms <= 0) {
      setV(value);
      return;
    }
    const wait = ms - (Date.now() - lastRef.current);
    if (wait <= 0) {
      lastRef.current = Date.now();
      setV(value);
      return;
    }
    const t = setTimeout(() => {
      lastRef.current = Date.now();
      setV(value);
    }, wait);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function Markdown({
  text,
  streaming,
  trailing,
}: {
  text: string;
  streaming?: boolean;
  trailing?: React.ReactNode;
}): JSX.Element {
  const throttled = useThrottled(text, streaming ? 80 : 0);
  const blocks = React.useMemo(() => parseMarkdownBlocks(throttled), [throttled]);
  const lastIdx = blocks.length - 1;
  return <div className="md">{blocks.map((b, i) => renderBlock(b, i, i === lastIdx ? trailing : undefined))}</div>;
}
