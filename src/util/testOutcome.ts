// Interpretação do resultado da suíte de testes (pytest) — pura e testável, compartilhada com a
// webview. Traduz o exit code do pytest em um estado semântico em vez de "!= 0 == vermelho".
// Convenção do pytest: 0=passou, 1=falhou, 2/4=erro de uso, 3=erro interno, 5=NENHUM teste coletado.
export type TestOutcome = "passed" | "failed" | "no-tests" | "error";

// Marcador que o Runner injeta na saída quando mata o processo por timeout (ver Runner.runRaw).
const TIMEOUT_MARK = /interrompida após o tempo limite/i;
// "No module named pytest" ancorado a fim-de-token: NÃO casa pytest_asyncio, pytest-cov, etc.
const PYTEST_MISSING = /No module named ['"]?pytest['"]?(\s|$|['"])/i;

export function pytestOutcome(exitCode: number | null, output: string): TestOutcome {
  // Timeout ou pytest ausente no interpretador = erro de ambiente, NÃO falha de código do usuário.
  if (TIMEOUT_MARK.test(output) || PYTEST_MISSING.test(output)) return "error";
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
    default:
      return `erro do pytest (exit ${exitCode ?? "?"})`;
  }
}
