// Formatador de mensagem PURO da camada i18n da webview (o iframe não tem a API vscode.l10n, então a
// webview tem a própria camada). Suporta:
//   - interpolação nomeada: "olá {name}" + { name: "X" }
//   - UM bloco ICU plural por mensagem: "{count, plural, one{# arquivo} other{# arquivos}}" — resolve
//     one (n==1) / other pela regra de pt-BR/en/es (todas one/other) e troca # pelo número.
// A ordem — plural PRIMEIRO — é deliberada: o bloco plural consome seu próprio { }, então a
// interpolação nomeada depois não confunde o `one{…}`/`other{…}` com uma variável. Limitação conhecida:
// não há {var} nomeada DENTRO do bloco plural (use #); cobre o caso comum (PR de fundação). PURO.
export function formatMessage(template: string, params: Record<string, string | number> = {}): string {
  // 1) plural: {v, plural, one{...} other{...}} — one/other sem chaves aninhadas.
  let out = template.replace(
    /\{(\w+),\s*plural,\s*one\{([^{}]*)\}\s*other\{([^{}]*)\}\}/g,
    (_full, v: string, one: string, other: string) => {
      const n = Number(params[v] ?? 0);
      const chosen = n === 1 ? one : other;
      return chosen.replace(/#/g, String(n));
    }
  );
  // 2) interpolação nomeada: {var} restantes. Var ausente nos params fica literal (facilita achar buraco).
  out = out.replace(/\{(\w+)\}/g, (m, v: string) => (v in params ? String(params[v]) : m));
  return out;
}
