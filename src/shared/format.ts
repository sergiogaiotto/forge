// Formatador de mensagem PURO, COMPARTILHADO host↔webview (i18n). Suporta:
//   - interpolação nomeada: "olá {name}" + { name: "X" }
//   - UM bloco ICU plural por mensagem: "{count, plural, one{# arquivo} other{# arquivos}}" — resolve
//     one (n==1) / other pela regra de pt-BR/en/es (todas one/other) e troca # pelo número.
// A ordem — plural PRIMEIRO — é deliberada: o bloco plural consome seu próprio { }, então a
// interpolação nomeada depois não confunde o `one{…}`/`other{…}` com uma variável. Aceita a forma
// CANÔNICA do ICU com espaço (one {…}) além da compacta. Limitação: sem {var} nomeada DENTRO do bloco
// plural (use #). PURO — nem vscode nem React.
export function formatMessage(template: string, params: Record<string, string | number> = {}): string {
  let out = template.replace(
    /\{\s*(\w+)\s*,\s*plural\s*,\s*one\s*\{([^{}]*)\}\s*other\s*\{([^{}]*)\}\s*\}/g,
    (_full, v: string, one: string, other: string) => {
      const n = Number(params[v] ?? 0);
      const chosen = n === 1 ? one : other;
      return chosen.replace(/#/g, String(n));
    }
  );
  out = out.replace(/\{(\w+)\}/g, (m, v: string) => (v in params ? String(params[v]) : m));
  return out;
}
