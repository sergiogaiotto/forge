// Smoke test ADVISORY do Modo Projeto (P4): depois do gate estático (compileall/mypy) passar, rodamos a
// SUÍTE GERADA (pytest) contra a árvore materializada, usando o venv do workspace. Este módulo classifica
// o resultado do pytest numa mensagem advisory — NUNCA bloqueia o Aplicar, só informa. Puro/testável; o
// I/O (venv, spawn do pytest, materialização) fica no Controller.runProjectSmoke.
import { hostT } from "../i18n";
import { ValidatorResult } from "../shared/protocol";

export interface SmokeVerdict {
  ran: boolean; // true só quando o pytest REALMENTE executou testes (não pulado nem erro de ambiente)
  level: "info" | "warn"; // warn só quando testes existiram e FALHARAM (defeito do código gerado)
  message: string; // texto pt-BR para o aviso ancorado na resposta
}

// pytest exit codes: 0 passou · 1 testes falharam · 2 erro de uso · 3 erro interno · 4 uso incorreto ·
// 5 nenhum teste coletado. runFileCheck normaliza para status ok (0) / failed (!=0) / skipped (ENOENT ou
// timeout), sem expor o código — então distinguimos os casos pela SAÍDA. Distinção crucial: dependência
// ausente (ModuleNotFoundError) é problema de AMBIENTE (não instalamos nada por causa do egress
// deny-by-default), não defeito do código — vira advisory neutro, jamais um "falhou".
export function summarizeSmoke(result: ValidatorResult, language: "python" | "go" | "typescript" = "python"): SmokeVerdict {
  const out = result.output ?? "";

  if (result.status === "skipped") {
    const timedOut = /tempo|timeout/i.test(result.reason ?? "");
    const noTool = language === "go" ? "smoke.noGo" : language === "typescript" ? "smoke.noRunner" : "smoke.noPython";
    return {
      ran: false,
      level: "info",
      message: timedOut ? hostT("smoke.timeout") : hostT(noTool),
    };
  }

  if (language === "go") return summarizeGoSmoke(result, out);
  if (language === "typescript") return summarizeNodeSmoke(result, out);

  // status "ok" (exit 0) SEMPRE significa que os testes rodaram e passaram — decidido PRIMEIRO, antes de
  // qualquer varredura por texto na saída. Um teste que passa pode logar "ImportError"/"No module named"
  // no output (nome de teste, warning, log do código sob teste); reclassificar por substring mascararia um
  // verde legítimo. Espelha a lição do classificador irmão pytestOutcome (util/testOutcome.ts).
  if (result.status === "ok") {
    const m = out.match(/(\d+)\s+passed/i);
    return {
      ran: true,
      level: "info",
      // Sem contagem confiável na saída, a variante sem número ("os testes gerados PASSARAM") evita
      // interpolar um placeholder que não é número — cada locale flexiona a frase inteira.
      message: m ? hostT("smoke.passed", { count: m[1] }) : hostT("smoke.passedAll"),
    };
  }

  // status "failed": os testes RODARAM e alguns falharam? O resumo "N failed" é o sinal confiável — uma
  // menção a ImportError no traceback de um teste que falhou/asserta sobre erro NÃO deve virar "ambiente".
  const fm = out.match(/(\d+)\s+failed/i);
  if (fm) {
    return {
      ran: true,
      level: "warn",
      message: hostT("smoke.failed", { count: fm[1] }),
    };
  }

  if (/no tests ran|collected 0 items/i.test(out)) {
    return { ran: false, level: "info", message: hostT("smoke.none") };
  }

  // Sem testes executados e sem falhas contadas ⇒ erro de COLETA. pytest não instalado no venv? Ancora no
  // token `pytest` (um `pytest_asyncio` ausente é uma DEP de plugin, não o pytest) — como em testOutcome.ts.
  if (/no module named ['"]?pytest['"]?(\s|$|['"]|\))/i.test(out)) {
    return { ran: false, level: "info", message: hostT("smoke.noPytest") };
  }

  // Falha ao IMPORTAR na coleta: dep de terceiros ausente OU um módulo do PRÓPRIO projeto que não resolve
  // (ex.: layout src/ sem instalação editável). Não instalamos nada (egress) — advisory honesto quanto à
  // ambiguidade, sem cravar a causa errada.
  if (/modulenotfounderror|no module named|cannot import name|importerror/i.test(out)) {
    return { ran: false, level: "info", message: hostT("smoke.importFailed") };
  }

  return { ran: true, level: "warn", message: hostT("smoke.notPassed") };
}

// Classifica a saída do `go test ./...`. Exit 0 = tudo passou. Exit != 0 pode ser: teste(s) FALHARAM
// (linhas "--- FAIL: TestX") OU um erro de BUILD/DEPS (offline não resolve dep de terceiros / drift de
// compilação) — que é problema de AMBIENTE, não defeito do teste → advisory NEUTRO (jamais "falhou"),
// espelhando a distinção ModuleNotFoundError do Python. "no test files" = suíte não coletada.
function summarizeGoSmoke(result: ValidatorResult, out: string): SmokeVerdict {
  if (result.status === "ok") {
    // exit 0 NÃO garante que testes RODARAM: um _test.go só com Example-sem-`// Output:`, helpers ou tudo
    // atrás de build tags COMPILA e sai 0 com "[no tests to run]"/"[no test files]" (o pytest sai 5 nesse
    // caso, o go sai 0 — o buraco de falso-verde que a revisão AO VIVO pegou). Só declara "passou" com
    // EVIDÊNCIA de um pacote que rodou testes: uma linha "ok<sep>pkg<sep>DURs" SEM o sufixo "[no tests…]".
    const ranReal = out.split(/\r?\n/).some((l) => /^ok\s+\S/.test(l) && !/\[no tests? (?:to run|files)\]/i.test(l));
    return ranReal
      ? { ran: true, level: "info", message: hostT("smoke.passedAll") }
      : { ran: false, level: "info", message: hostT("smoke.none") };
  }
  const fails = (out.match(/^--- FAIL:/gm) ?? []).length;
  if (fails > 0) {
    return { ran: true, level: "warn", message: hostT("smoke.failed", { count: String(fails) }) };
  }
  if (/no test files|no tests to run/i.test(out)) {
    return { ran: false, level: "info", message: hostT("smoke.none") };
  }
  // Erro de BUILD/DEPS (não é "teste falhou"): imports não resolvidos offline, import halucinado que parece
  // stdlib ("is not in std"/"not in GOROOT"), pacote sem .go, drift de compilação. Neutro (ambiente).
  if (/cannot find (package|module)|no required module provides|build constraints exclude|missing go\.sum|updates to go\.mod needed|imported and not used|undefined:|is not in std|is not in goroot|no go files|^#\s|go: /im.test(out)) {
    return { ran: false, level: "info", message: hostT("smoke.buildIssue") };
  }
  return { ran: true, level: "warn", message: hostT("smoke.notPassed") };
}

// Classifica a saída de vitest / jest (a suíte TS gerada, rodada via `node <entry>` com o node_modules do
// workspace junctionado). Formatos capturados AO VIVO:
//   vitest: PASS(0) "Tests  2 passed (2)" · FAIL(1) "Tests  1 failed (1)" · none(1) "No test files found"
//   jest:   PASS(0) "Tests:       2 passed, 2 total" · FAIL(1) "Tests:       N failed, ..." ·
//           none(1) "No tests found" · AMBIENTE(1) "Test suite failed to run" + "Tests:       0 total"
// CRUCIAL: exit != 0 cobre FALHA, NENHUM-TESTE e AMBIENTE (ts-jest quebra por versão o tempo todo) — então o
// veredito vem do TEXTO, ancorado na linha `Tests` (NÃO `Test Suites`, que conta suítes: um `Test Suites: 1
// failed` de erro de transform NÃO é teste falhando). Direção sempre correta mesmo se o resumo truncar:
// exit 0 ⇒ passou; caso contrário, sem contagem de falha ⇒ notPassed (warn). O ts-jest frágil vira AMBIENTE.
function summarizeNodeSmoke(result: ValidatorResult, out: string): SmokeVerdict {
  // exit 0: vitest/jest só saem 0 quando testes RODARAM e passaram (sem --passWithNoTests, que não passamos).
  if (result.status === "ok") {
    const m = out.match(/Tests[:\s]+(\d+)\s+passed/i);
    return { ran: true, level: "info", message: m ? hostT("smoke.node.passed", { count: m[1] }) : hostT("smoke.node.passedAll") };
  }
  // exit != 0: lê a linha `Tests` (resumo dos TESTES, não das suítes). `\d+ failed` com N>0 = testes falharam.
  const testsLine = out.match(/^[ \t]*Tests[:\s][^\n]*/im)?.[0] ?? "";
  const failed = testsLine.match(/(\d+)\s+failed/i);
  if (failed && Number(failed[1]) > 0) {
    return { ran: true, level: "warn", message: hostT("smoke.node.failed", { count: failed[1] }) };
  }
  // Nenhum teste coletado: vitest "No test files found" · jest "No tests found".
  if (/No tests?(?: files?)? found/i.test(out)) {
    return { ran: false, level: "info", message: hostT("smoke.none") };
  }
  // AMBIENTE (não é "teste falhou"): a suíte não pôde carregar/transformar/resolver. O caso dominante é o
  // ts-jest incompatível ("Test suite failed to run" + "Tests: 0 total"); também transform/import de vitest.
  if (/Test suite failed to run|Tests:\s+0\s+total|Cannot find (?:module|package)|Failed to (?:load|resolve|parse)|SyntaxError|TransformError|ERR_MODULE_NOT_FOUND/i.test(out)) {
    return { ran: false, level: "info", message: hostT("smoke.buildIssue") };
  }
  return { ran: true, level: "warn", message: hostT("smoke.notPassed") };
}
