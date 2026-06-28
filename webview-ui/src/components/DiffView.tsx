import React, { useMemo } from "react";

type Line = { type: "add" | "del" | "ctx"; text: string };

function diffLines(aText: string, bText: string): Line[] {
  const a = aText.length ? aText.split("\n") : [];
  const b = bText.length ? bText.split("\n") : [];
  // Protege contra tamanhos patológicos.
  if (a.length > 600 || b.length > 600) {
    return b.map((text) => ({ type: a.length ? "ctx" : "add", text }));
  }
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: Line[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "ctx", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: "del", text: a[i] });
      i++;
    } else {
      out.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ type: "del", text: a[i++] });
  while (j < m) out.push({ type: "add", text: b[j++] });
  return out;
}

export function DiffView({ original, modified }: { original: string; modified: string }): JSX.Element {
  const lines = useMemo(() => diffLines(original, modified), [original, modified]);
  return (
    <div className="diff-body">
      {lines.map((l, idx) => (
        <div key={idx} className={`diff-line ${l.type === "ctx" ? "" : l.type}`}>
          <span className="gutter">{l.type === "add" ? "+" : l.type === "del" ? "−" : ""}</span>
          <span className="content" style={l.type === "ctx" ? { color: "#8b8b8b" } : undefined}>
            {l.text || " "}
          </span>
        </div>
      ))}
    </div>
  );
}
