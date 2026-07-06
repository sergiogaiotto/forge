// Smoke test ADVISORY do Modo Projeto (P4): depois do gate estático (compileall/mypy) passar, rodamos a
// SUÍTE GERADA (pytest) contra a árvore materializada, usando o venv do workspace. Este módulo classifica
// o resultado do pytest numa mensagem advisory — NUNCA bloqueia o Aplicar, só informa. Puro/testável; o
// I/O (venv, spawn do pytest, materialização) fica no Controller.runProjectSmoke.
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
export function summarizeSmoke(result: ValidatorResult): SmokeVerdict {
  const out = result.output ?? "";

  if (result.status === "skipped") {
    const timedOut = /tempo|timeout/i.test(result.reason ?? "");
    return {
      ran: false,
      level: "info",
      message: timedOut
        ? "Smoke test dos testes gerados: tempo esgotado (inconclusivo — não bloqueia)."
        : "Smoke test pulado: Python indisponível para rodar a suíte gerada.",
    };
  }

  // status "ok" (exit 0) SEMPRE significa que os testes rodaram e passaram — decidido PRIMEIRO, antes de
  // qualquer varredura por texto na saída. Um teste que passa pode logar "ImportError"/"No module named"
  // no output (nome de teste, warning, log do código sob teste); reclassificar por substring mascararia um
  // verde legítimo. Espelha a lição do classificador irmão pytestOutcome (util/testOutcome.ts).
  if (result.status === "ok") {
    const m = out.match(/(\d+)\s+passed/i);
    const n = m ? m[1] : "os";
    return {
      ran: true,
      level: "info",
      message: `Smoke test: ${n} teste(s) gerado(s) PASSARAM no venv do workspace — o projeto de fato roda, não só compila.`,
    };
  }

  // status "failed": os testes RODARAM e alguns falharam? O resumo "N failed" é o sinal confiável — uma
  // menção a ImportError no traceback de um teste que falhou/asserta sobre erro NÃO deve virar "ambiente".
  const fm = out.match(/(\d+)\s+failed/i);
  if (fm) {
    return {
      ran: true,
      level: "warn",
      message: `Smoke test: ${fm[1]} teste(s) gerado(s) FALHARAM no venv do workspace — revise antes de aplicar. (Advisory: o gate não bloqueia o Aplicar por isto.)`,
    };
  }

  if (/no tests ran|collected 0 items/i.test(out)) {
    return { ran: false, level: "info", message: "Smoke test: nenhum teste foi coletado na suíte gerada." };
  }

  // Sem testes executados e sem falhas contadas ⇒ erro de COLETA. pytest não instalado no venv? Ancora no
  // token `pytest` (um `pytest_asyncio` ausente é uma DEP de plugin, não o pytest) — como em testOutcome.ts.
  if (/no module named ['"]?pytest['"]?(\s|$|['"]|\))/i.test(out)) {
    return {
      ran: false,
      level: "info",
      message: "Smoke test pulado: pytest não está instalado no venv. Rode Preparar ambiente para validar que os testes gerados passam.",
    };
  }

  // Falha ao IMPORTAR na coleta: dep de terceiros ausente OU um módulo do PRÓPRIO projeto que não resolve
  // (ex.: layout src/ sem instalação editável). Não instalamos nada (egress) — advisory honesto quanto à
  // ambiguidade, sem cravar a causa errada.
  if (/modulenotfounderror|no module named|cannot import name|importerror/i.test(out)) {
    return {
      ran: false,
      level: "info",
      message: "Smoke test pulado: não consegui importar todos os módulos (dependências de terceiros ausentes, ou o projeto precisa de instalação editável). Rode Preparar ambiente — os testes gerados ainda não foram executados.",
    };
  }

  return {
    ran: true,
    level: "warn",
    message: "Smoke test: a suíte gerada não passou (veja os logs do FORGE em Mostrar logs). Revise antes de aplicar. (Advisory: não bloqueia o Aplicar.)",
  };
}
