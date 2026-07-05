// Simulate what mypy outputs
const mypyOutput = `src/app.py:1: error: Module "src.domain.entities" has no attribute "OrderStatus" [attr-defined]
/src/app.py:2: error: Some error`;

// Parse with relToRoot which normalizes via normGatePath
function relToRoot(root: string, p: string): string {
  const normGatePath = (p: string) => (p ?? '')
    .replace(/\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .trim();
  
  const raw = (p ?? "").trim();
  if (raw && (raw.startsWith('/') || /^[A-Za-z]:[\/]/.test(raw))) {
    // Would do path.relative but simulate it
    return normGatePath(raw.replace(/^\//, ''));
  }
  return normGatePath(raw);
}

for (const line of mypyOutput.split('\n')) {
  const m = /^(.*?):(\d+):(?:\d+:)?\s*(error|note):\s*(.*)$/.exec(line);
  if (m && m[3] === 'error') {
    const path = relToRoot('', m[1]);
    console.log(`Raw: "${m[1]}" | Normalized: "${path}"`);
  }
}
