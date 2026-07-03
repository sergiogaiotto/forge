// Interpretação do resultado da suíte de testes (pytest) — pura e testável, compartilhada com a
// webview. Traduz o exit code do pytest em um estado semântico em vez de "!= 0 == vermelho".
// Convenção do pytest: 0=passou, 1=falhou, 2/4=erro de uso, 3=erro interno, 5=NENHUM teste coletado.
// "env-missing" = o RUNNER não existe no ambiente (pytest ausente / comando não reconhecido) —
// problema de AMBIENTE acionável (instalar), não falha de código nem erro genérico.
export type TestOutcome = "passed" | "failed" | "no-tests" | "env-missing" | "error";

// Marcador que o Runner injeta na saída quando mata o processo por timeout (ver Runner.runRaw).
const TIMEOUT_MARK = /interrompida após o tempo limite/i;
// "No module named pytest" ancorado a fim-de-token: NÃO casa pytest_asyncio, pytest-cov, etc.
const PYTEST_MISSING = /No module named ['"]?pytest['"]?(\s|$|['"])/i;

export function pytestOutcome(exitCode: number | null, output: string): TestOutcome {
  // Timeout = erro genérico (não adianta instalar nada).
  if (TIMEOUT_MARK.test(output)) return "error";
  // Runner ausente: pytest não instalado no interpretador, ou o executável nem existe no shell.
  // SÓ pelos sinais inequívocos: o token pytest do "No module named" e os exit codes do próprio
  // shell (9009 = cmd.exe "comando desconhecido"; 127 = sh "command not found"). Texto livre tipo
  // "command not found" na saída NÃO conta — um teste que invoca binário ausente imprime isso com
  // exit 1 e reclassificar mascararia uma falha REAL do gate (confirmado em revisão adversarial).
  if (PYTEST_MISSING.test(output) || exitCode === 9009 || exitCode === 127) return "env-missing";
  switch (exitCode) {
    case 0:
      return "passed";
    case 1:
      return "failed";
    case 5:
      return "no-tests";
    default:
      return "error"; // 2, 3, 4 ou null (spawn/erro)
  }
}

export function testOutcomeLabel(o: TestOutcome, exitCode: number | null): string {
  switch (o) {
    case "passed":
      return "testes verdes";
    case "failed":
      return "testes falharam";
    case "no-tests":
      return "nenhum teste coletado";
    case "env-missing":
      return "pytest ausente no ambiente";
    default:
      return `erro do pytest (exit ${exitCode ?? "?"})`;
  }
}
