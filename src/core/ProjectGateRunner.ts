import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ManagedConfig } from "../config/ManagedConfig";
import type { ObsEvent } from "../obs/types";
import type { BlueprintFileView, ExtToWebview, ProjectArchitecture, ProjectLanguage } from "../shared/protocol";
import { hostT } from "../i18n";
import { runFileCheck } from "../util/execCheck";
import { safeWorkspacePath } from "../util/safePath";
import { findLayerViolations, layerRuleLabel } from "../util/layerCheck";
import { evaluateDodGate } from "../util/dodCheck";
import { scanA11y } from "../util/a11yLint";
import { summarizeSmoke } from "../util/smoke";
import { buildBanditInstall, buildMypyInstall, buildRuffInstall, findVenvPython } from "../util/pythonEnv";
import { reconcileRequirements } from "../util/pythonDeps";
import { buildGateTsconfig, findWorkspaceTscJs } from "../util/nodeEnv";
import { parseBanditReport, SecurityMode, splitSecurityFindings } from "../util/banditParse";
import { parseRuffReport, ruffAdvisories } from "../util/ruffParse";
import type { RunService } from "./RunService";
import type { Task } from "./Task";
import {
  contractUnverified,
  GateCheckResult,
  isBlockingTscContract,
  isTscSyntaxError,
  mypyUnavailable,
  normGatePath,
  parseCompileallErrors,
  parseGofmtErrors,
  parseGoBuildErrors,
  parseMypyErrors,
  parseTscErrors,
  ProjectGateSummary,
  requiresContractConfirmation,
  summarizeGate,
  syntheticInitDirs,
  tscErrorsToMap,
  tscUnavailable,
} from "./projectGate";

// ProjectGateRunner — o cluster do GATE de projeto (compilação/contrato/arquitetura/DoD/segurança/smoke)
// extraído do Controller (~600 linhas god-object) para uma unidade INJETÁVEL e TESTÁVEL. A ORQUESTRAÇÃO
// (dispatch por linguagem, ordem dos eixos, cômputo dos flags de contrato, DoD que bloqueia-todos) era o
// que não tinha teste — agora vira asserção de CI com um runService/task fake. Modelo de DI: o mesmo do
// RunService já provado no repo.
//
// FRONTEIRA DE ESTADO (a parte crítica): os 3 flags que o gate calcula — `lastGateRun` e os dois de
// contrato — são estado do Controller LIDO em outros lugares (fluxo de Aplicar, "Re-verificar contrato").
// Para não vazar o host pelo protocolo (armadilha conhecida), o runner NÃO guarda esse estado: `run()`
// RETORNA um `GateRunResult` tipado, e o Controller atribui aos próprios campos. O `repairProjectFromGate`
// (que chama o provider/LLM) NÃO faz parte deste cluster e permanece no Controller.

// gatePassed inlinado (puro) — importá-lo de SkillValidator arrastaria o logger acoplado ao vscode e
// quebraria o teste unitário do runner (o require de "vscode" só existe no extension host). Mesma
// semântica: o gate por-arquivo só falha se um validador de GATE de fato reprovou (skipped ≠ failed).
function gatePassed(results: readonly { gate?: boolean; status?: string }[]): boolean {
  return !results.some((r) => r.gate && r.status === "failed");
}

/** Atualização de estado do Controller que o gate computa e devolve (em vez de escrever direto). */
export interface GateStateUpdate {
  lastGateRun: { language: ProjectLanguage; architecture: ProjectArchitecture; complete: boolean };
  contractUnverified: boolean;
  contractUnverifiedHard: boolean;
}

/** Resultado do gate: o resumo (ou null) + a atualização de estado (null = não tocar os flags do Controller). */
export interface GateRunResult {
  summary: ProjectGateSummary | null;
  state: GateStateUpdate | null;
}

/** Dependências injetadas — tight: task/config/runService/post/obs/projectSession/workspaceRoot + puros. */
export interface GateRunnerDeps {
  currentTask(): Task | undefined;
  projectSession(): { files: BlueprintFileView[] } | null;
  workspaceRoot(): string | undefined;
  config: ManagedConfig;
  runService: RunService;
  post(msg: ExtToWebview): void;
  obs: { record(e: ObsEvent): void };
  // Logger injetado (não importamos "../util/logger" direto: ele acopla o vscode e quebraria o teste
  // unitário do runner — mesmo motivo do warn injetável no EgressEnforcer/GatewayRelaySink).
  log: { info(m: string): void; warn(m: string, e?: unknown): void };
}

export class ProjectGateRunner {
  constructor(private readonly deps: GateRunnerDeps) {}

  // Gate workspace-wide do Modo Projeto (Onda 1). Materializa TODAS as propostas juntas numa árvore temp
  // (contida via safeWorkspacePath), semeia `__init__.py` sintéticos e roda compileall + mypy sobre o
  // CONJUNTO — pegando o drift de contrato que a validação por-arquivo (isolada) não vê. O resultado por
  // arquivo alimenta `entry.gateOk`; `applyProposal` já recusa `!gateOk` quando gateBlocksApply().
  // Degradação segura: se as ferramentas não rodam (sem python/mypy), o gate é CONSULTIVO — não bloqueia.
  async run(language: ProjectLanguage, architecture: ProjectArchitecture, complete: boolean): Promise<GateRunResult> {
    const task = this.deps.currentTask();
    // P4: Python (compileall/mypy), TypeScript (tsc) e Go (gofmt + go build). Java roda SÓ a arquitetura
    // (o gate de compilação javac é follow-up: sem JDK validável no ambiente de dev, não se escreve às cegas).
    if (!task || (language !== "python" && language !== "typescript" && language !== "go" && language !== "java")) return { summary: null, state: null };
    // Espera as validações por-arquivo em voo antes de tocar em gateOk (senão uma advisory tardia
    // reescreveria o veredito do gate de volta para true — corrida real).
    await task.settleValidations();

    // Exclui células (.ipynb) e PARCIAIS (truncados): o parcial é conhecidamente incompleto e já tem
    // tratamento honesto próprio (pulado no "Aplicar tudo" + aviso no cartão) — um SyntaxError por corte
    // não deve virar bloqueio de gate, e materializá-lo poluiria a resolução do conjunto.
    const props = [...task.proposals.values()].filter((e) => !e.proposal.cell && !e.proposal.partial);
    const codeRe = language === "typescript" ? /\.[tj]sx?$/i : language === "go" ? /\.go$/i : language === "java" ? /\.java$/i : /\.py$/i;
    const hasCode = props.some((e) => codeRe.test(e.proposal.filePath));
    if (!hasCode) return { summary: null, state: null }; // nada compilável na linguagem do projeto — gate não se aplica
    // Guarda os args para o "Re-verificar contrato" (re-rodar o gate sobre as MESMAS propostas depois
    // de "Preparar ambiente", sem regenerar via LLM). Devolvido no state (o Controller persiste em lastGateRun).
    const lastGateRun = { language, architecture, complete };

    const gateStart = Date.now(); // P3: span do gate (compileall/mypy/arquitetura/DoD/segurança)
    let root: string | undefined;
    try {
      root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-gate-"));
      // Materializa a árvore (cada path CONTIDO na raiz temp) + __init__.py sintéticos (só Python).
      // Compartilhado com o smoke test (runProjectSmoke) — ver writeProjectTree.
      await this.writeProjectTree(root, props, language);

      const timeoutMs = 120_000;
      const outputCap = 32_000; // teto amplo: um projeto MUITO drifado emite muitos erros; não truncar a atribuição
      const checks: GateCheckResult[] = [];
      const securityMode = this.deps.config.securityGate();
      const deadImportsMode = this.deps.config.deadImportsGate(); // F-18: gate advisory de imports mortos (ruff F401)
      let tscTypeAdvisories: string[] = []; // avisos de TIPO do tsc (advisory) — só TypeScript
      let goBuildAdvisories: string[] = []; // avisos do go build/vet (advisory) — só Go
      // F-03: o compileall reprovou (erro de SINTAXE no conjunto)? O mypy ABORTA na 1ª falha de sintaxe e
      // NÃO verifica o contrato cross-file dos DEMAIS arquivos — logo o contrato NÃO pode ser dado como
      // verificado (senão o drift dos outros arquivos fica mascarado). Só Python (mypy é o checador de contrato).
      let pySyntaxError = false;
      let py: string | undefined; // interpretador do gate Python (só no ramo Python; usado no security scan)

      // Universo conhecido do projeto (só usado pelo gate TS): propostas NÃO-célula (INCLUSIVE parciais, que
      // NÃO são materializadas na árvore temp) + arquivos já APLICADOS em rodadas anteriores. Um import
      // relativo a um desses vira TS2307 (o arquivo não está na árvore desta rodada) mas NÃO é drift — o
      // isBlockingTscContract o rebaixa a advisory. Sem isto, o gate TS falso-bloquearia geração incremental.
      const knownFiles = new Set<string>([
        ...[...task.proposals.values()].filter((e) => !e.proposal.cell).map((e) => normGatePath(e.proposal.filePath)),
        ...(this.deps.projectSession()?.files ?? []).filter((f) => f.status === "applied").map((f) => normGatePath(f.path)),
      ]);

      if (language === "python") {
        py = await this.resolveGatePython();
        // Onda 1.5: garante o mypy no venv ANTES de checar — sem ele o gate só teria compileall (sintaxe) e
        // ficaria "parcial", deixando passar o drift de contrato (o ImportError fantasma que derruba o app).
        await this.ensureGateMypy(py);
        // Garante o bandit no venv (best-effort, como o mypy) para o gate de segurança morder out-of-the-box.
        if (securityMode !== "off") await this.ensureGateBandit(py);
        if (deadImportsMode) await this.ensureGateRuff(py); // F-18: ruff no venv (best-effort), só se ligado

        // compileall (stdlib, gate:true): pega erro de SINTAXE em qualquer arquivo do conjunto.
        const compile = await runFileCheck({ id: "gate:compileall", label: "compileall", gate: true }, py, ["-m", "compileall", "-q", "."], { cwd: root, timeoutMs, outputCap });
        checks.push({ result: compile, errors: parseCompileallErrors(compile.output, root) });
        pySyntaxError = compile.status === "failed"; // F-03: sintaxe quebrada → mypy aborta (ver contrato abaixo)

        // mypy (gate:true quando instalado): pega o DRIFT de contrato (import/atributo fantasma) cross-file.
        // --ignore-missing-imports neutraliza o ruído de deps de terceiros (fastapi/jinja não instalados no
        // temp) preservando os erros de módulos DESTE projeto. Não instalado → skipped (consultivo).
        let mypy = await runFileCheck(
          { id: "gate:mypy", label: "mypy", gate: true },
          py,
          ["-m", "mypy", "--ignore-missing-imports", "--no-error-summary", "--no-color-output", "--hide-error-context", "--no-pretty", "."],
          { cwd: root, timeoutMs, outputCap }
        );
        if (mypyUnavailable(mypy)) mypy = { ...mypy, status: "skipped", reason: "mypy não instalado (gate consultivo)" };
        const mypyErrors = mypy.status === "failed" ? parseMypyErrors(mypy.output, root) : new Map<string, string[]>();
        // Defesa em profundidade: mypy que reprovou SEM nenhum erro `path:linha` atribuível não type-checou
        // — ABORTOU (fatal/coleta, ex.: exit 2). Um type-check real sempre emite linhas atribuíveis. Tratar
        // como consultivo (skipped) em vez de deixar passar mascarado: o resumo vira "parcial", não "verde".
        if (mypy.status === "failed" && mypyErrors.size === 0) {
          mypy = { ...mypy, status: "skipped", reason: "mypy não pôde analisar (abort/fatal) — gate consultivo" };
        }
        checks.push({ result: mypy, errors: mypyErrors });
      } else if (language === "typescript") {
        // TypeScript (P4): tsc --noEmit sobre a árvore. Decisão (A): SINTAXE (TS1xxx) bloqueia; TIPO (TS2xxx+)
        // é advisory — sem node_modules no temp o tsc é ruidoso (deps/tipos ausentes → cascata). tsc ausente
        // → consultivo. A ARQUITETURA (abaixo) roda igual, agora sobre imports TS.
        const ts = await this.runTsChecks(root, timeoutMs, outputCap, knownFiles);
        checks.push(...ts.checks);
        tscTypeAdvisories = ts.advisories;
      } else if (language === "go") {
        // Go (P4): gofmt (SINTAXE) bloqueia — parse-only, offline, sem deps, ZERO risco de falso-bloqueio por
        // dep de terceiros ausente; go build/vet (compilação/drift) é advisory — sem o module cache o compilador
        // erra em toda dep de terceiros (egress deny-by-default). Decisão (A), igual ao TS. A ARQUITETURA
        // (abaixo) roda igual, agora sobre imports Go (casamento por diretório/pacote).
        const g = await this.runGoChecks(root, timeoutMs, outputCap);
        checks.push(...g.checks);
        goBuildAdvisories = g.advisories;
      } else {
        // Java (P4): SÓ a ARQUITETURA (abaixo) — o gate de compilação javac é follow-up. Sem um JDK validável
        // no ambiente de dev, não se escreve o classificador de erros do javac às cegas (o falso-bloqueio do gate
        // Go só foi pego por repro AO VIVO). `checks` fica vazio → o toolchain é consultivo; a regra de camadas
        // (por pacote declarado) roda igual e pode bloquear. DoD/segurança/smoke/reconcile seguem Python-only.
      }

      const gate = summarizeGate(checks); // toolchain (compileall/mypy | tsc-sintaxe) → advisory/resumo honestos

      // Gate de ARQUITETURA (P2): a REGRA DE OURO — a camada interna (domínio/entidades/model) não pode
      // importar a externa (adapters/infra/repository). O mypy não pega (importar na direção errada tipa e
      // compila). PURO sobre o conteúdo das propostas (roda até sem Python). Fica SEPARADO do toolchain:
      // BLOQUEIA o Aplicar, mas (1) FORA do summarizeGate — para não poluir advisory/parcial quando só ele
      // roda; e (2) FORA do auto-reparo de type-drift — cujo prompt "reuse o contrato" empurraria a
      // re-violar. O dev corrige a DIREÇÃO do import (inverter a dependência / usar uma port).
      const violations = findLayerViolations(
        props.map((e) => ({ path: normGatePath(e.proposal.filePath), content: e.proposal.modified })),
        architecture,
        language
      );
      const architectureErrors = violations.map((v) => ({
        path: v.path,
        errors: [hostT("gate.archViolation", { arch: architecture, rule: layerRuleLabel(architecture), imports: v.imports.join(", ") })],
      }));

      // Definição de PRONTO (DoD, P2): requisitos AUSENTES do CONJUNTO (manifesto de deps / qualquer teste /
      // README com "como rodar"). Diferente da arquitetura (que culpa UM arquivo), a falta é do conjunto —
      // não se atribui a um arquivo. Só avalia quando COMPLETO (todo o blueprint gerado); geração parcial
      // (falha do provedor) não deve bloquear. O universo do DoD é o PROJETO INTEIRO — as propostas desta
      // rodada (INCLUSIVE as parciais/truncadas, que aqui entram por PRESENÇA — não pelo `props` filtrado, que
      // as descarta) MAIS os arquivos já APLICADOS em rodadas anteriores. Sem isso o DoD acusaria como ausente
      // um manifesto/README que só truncou ou que já foi aplicado (falsos-positivos da revisão adversarial).
      // Quando algo falta de fato, FECHA o Aplicar de TODOS — bloqueio + aviso, SEM auto-reparo (o que falta é
      // bloco de arquivo NOVO, que o reparo de type-drift descarta).
      const dodProposals = [...task.proposals.values()]
        .filter((e) => !e.proposal.cell)
        .map((e) => ({ path: normGatePath(e.proposal.filePath), content: e.proposal.modified, partial: e.proposal.partial }));
      const appliedPaths = (this.deps.projectSession()?.files ?? [])
        .filter((f) => f.status === "applied")
        .map((f) => normGatePath(f.path));
      const dod = evaluateDodGate({ complete, enabled: this.deps.config.definitionOfDone(), language, proposals: dodProposals, appliedPaths });
      const dodErrors = dod.errors;
      const dodBlocksAll = dod.blocks;

      // Gate de SEGURANÇA (P2): SAST (bandit) sobre a árvore materializada. Conservador — só severidade ALTA
      // E confiança ALTA BLOQUEIA (senha hardcoded, eval de input, cripto fraca); o resto é advisory. O bandit
      // analisa por AST (NÃO executa o código, ao contrário do smoke test). SEPARADO do toolchain (fora do
      // summarizeGate/auto-reparo), como a arquitetura. bandit ausente/sem relatório → null (fail-open).
      // bandit é Python-only (usa o `py` resolvido). Em TypeScript a segurança não roda por ora (follow-up).
      const security = language === "python" && securityMode !== "off" ? await this.runSecurityScan(py!, root, securityMode) : null;
      const securityErrors = security?.blocking ?? [];
      const securityAdvisories = security?.advisories ?? [];
      // F-18: imports mortos (ruff F401) — Python-only + ligado. Advisory PURO: string[] (sem split de
      // bloqueio), coalescido a []. NUNCA toca `blocked`/`gateOk`/`totalBlocked`/`files` (invariante advisory).
      const deadImportAdvisories = language === "python" && deadImportsMode ? (await this.runDeadImportScan(py!, root)) ?? [] : [];
      // A11y (advisory, #06): linter PURO-TS sobre os arquivos de FRONTEND gerados (html/jsx/tsx/vue/svelte),
      // QUALQUER que seja a linguagem do projeto (React SPA, ou Jinja num FastAPI) — o motor que faltava (o
      // único domínio sem validação da SAÍDA; o isFrontendRequest só força a skill no prompt). Nunca bloqueia.
      const a11yAdvisories = scanA11y(props.map((e) => ({ path: normGatePath(e.proposal.filePath), content: e.proposal.modified }))).map((f) => `${f.path}:${f.line} — ${f.message}`);
      if (a11yAdvisories.length) this.deps.log.info(`Gate a11y: ${a11yAdvisories.length} aviso(s) de acessibilidade (advisory) — ${a11yAdvisories.slice(0, 5).join(" | ")}`);

      // Propaga por-arquivo para gateOk: bloqueia arquivo com erro do TOOLCHAIN (atribuído), violação de
      // arquitetura OU achado de segurança bloqueante; o DoD (ausência project-level) bloqueia TODOS.
      // gatePassed([]) = true no caso comum; um validador de skill gate:true reprovado persiste.
      const blocked = new Set([...gate.fileErrors.map((f) => f.path), ...violations.map((v) => v.path), ...securityErrors.map((s) => s.path)]);
      for (const e of props) {
        e.gateOk = gatePassed(e.results ?? []) && !blocked.has(normGatePath(e.proposal.filePath)) && !dodBlocksAll;
      }

      const totalBlocked = gate.fileErrors.length + architectureErrors.length + securityErrors.length;
      const fileParts: string[] = [];
      if (gate.fileErrors.length) fileParts.push(hostT(language === "go" ? "gate.part.syntaxGo" : "gate.part.compile", { count: gate.fileErrors.length }));
      if (architectureErrors.length) fileParts.push(hostT("gate.part.arch", { count: architectureErrors.length }));
      if (securityErrors.length) fileParts.push(hostT("gate.part.security", { count: securityErrors.length }));
      // Avisos de TIPO do tsc / do go build (advisory): mostram a CONTAGEM no resumo (o veredito completo exige
      // as deps). Os erros de SINTAXE (TS1xxx / gofmt), esses, entram em gate.fileErrors (bloqueiam) e pintam
      // os cartões. Só um dos sufixos é não-vazio (a linguagem é uma só).
      const tscSuffix = tscTypeAdvisories.length ? hostT("gate.tscSuffix", { count: tscTypeAdvisories.length }) : "";
      const goSuffix = goBuildAdvisories.length ? hostT("gate.goSuffix", { count: goBuildAdvisories.length }) : "";
      const langSuffix = tscSuffix + goSuffix;
      // F-18: sufixo advisory de imports mortos — só decora o resumo quando NADA bloqueia (mesma semântica
      // de supressão do gate.securitySuffix). Só Python, então não interage com langSuffix (TS/Go).
      const deadImportsSuffix = deadImportAdvisories.length && totalBlocked === 0 && !dodBlocksAll ? hostT("gate.deadImportsSuffix", { count: deadImportAdvisories.length }) : "";
      // O resumo-base do summarizeGate é redigido para o toolchain Python (compileall/mypy). Em Go, reescreve
      // com os nomes das ferramentas certas (gofmt/go build) para os casos SEM bloqueio (advisory/parcial/verde);
      // os casos COM bloqueio já têm texto próprio abaixo.
      const goBaseSummary = gate.advisory
        ? hostT("gate.go.advisory")
        : gate.fileErrors.length > 0
          ? hostT("gate.go.failed", { count: gate.fileErrors.length })
          : gate.projectErrors.length > 0
            ? hostT("gate.py.unattributed")
            : hostT("gate.go.ok");
      // Java roda SÓ a arquitetura (sem toolchain → gate.advisory=true); o resumo honesto diz isso.
      const javaBaseSummary = hostT("gate.java");
      const baseSummary = language === "go" ? goBaseSummary : language === "java" ? javaBaseSummary : gate.summary;
      const summary =
        (dodBlocksAll
          ? hostT("gate.dodIncomplete", { count: dodErrors.length }) + (totalBlocked > 0 ? hostT("gate.alsoBlocked", { count: totalBlocked, parts: fileParts.join(" · ") }) : "")
          : totalBlocked > 0
            ? hostT("gate.blocked", { count: totalBlocked, parts: fileParts.length ? ` — ${fileParts.join(" · ")}` : "" })
            : securityAdvisories.length
              ? baseSummary + hostT("gate.securitySuffix", { count: securityAdvisories.length })
              : baseSummary) + langSuffix + deadImportsSuffix;
      if (tscTypeAdvisories.length) this.deps.log.info(`Gate TS: ${tscTypeAdvisories.length} aviso(s) de tipo (advisory) — ${tscTypeAdvisories.slice(0, 5).join(" | ")}`);
      if (goBuildAdvisories.length) this.deps.log.info(`Gate Go: ${goBuildAdvisories.length} aviso(s) do go build (advisory) — ${goBuildAdvisories.slice(0, 5).join(" | ")}`);
      // A UI pinta os cartões de compilação/arquitetura/segurança (por-arquivo) e mostra DoD + avisos de
      // segurança como project-level; o auto-reparo (que consome o gate RETORNADO) recebe só os fileErrors.
      const securityView = securityAdvisories.length > 12 ? [...securityAdvisories.slice(0, 12), hostT("gate.moreSecurity", { count: securityAdvisories.length - 12 })] : securityAdvisories;
      // F-18: mesma poda de 12 dos avisos de segurança, com chave de overflow própria (canais independentes).
      const deadImportsView = deadImportAdvisories.length > 12 ? [...deadImportAdvisories.slice(0, 12), hostT("gate.moreDeadImports", { count: deadImportAdvisories.length - 12 })] : deadImportAdvisories;
      // Contrato cross-file NÃO verificado (Python compilou mas o mypy não rodou): "Aplicar tudo" passa a
      // exigir confirmação. NÃO conta se já há bloqueio duro (o dev corrige/força esse primeiro) — a
      // supressão vale SÓ para a semântica de confirmação; a POLÍTICA usa o flag CRU abaixo (senão
      // qualquer outro bloqueio + "Forçar bloqueados" viraria bypass da política).
      // F-03: erro de SINTAXE (compileall reprovou) faz o mypy abortar sem verificar o contrato dos DEMAIS
      // arquivos — o contrato NÃO está verificado, mesmo com gate.partial=false (que é false porque há
      // fileErrors do compileall). OR com pySyntaxError para o passo não implicar "contrato verificado".
      const contractUnverifiedNow = gate.partial || pySyntaxError;
      const contractUnverifiedFlag = requiresContractConfirmation(language, contractUnverifiedNow) && totalBlocked === 0 && !dodBlocksAll;
      const contractUnverifiedHardFlag = contractUnverified(language, contractUnverifiedNow, gate.advisory);
      // contractBlocked: a política do admin transforma a confirmação em bloqueio — a UI troca o botão
      // "Aplicar sem verificar contrato" pelo caminho de verificação real (Preparar ambiente → Re-verificar).
      const contractBlocked = contractUnverifiedHardFlag && this.deps.config.blockUnverifiedContract();
      this.deps.post({ type: "project/gate", advisory: gate.advisory, partial: gate.partial, requiresContractConfirm: contractUnverifiedFlag, contractBlocked, summary, files: [...gate.fileErrors, ...architectureErrors, ...securityErrors], projectErrors: gate.projectErrors, dod: dodErrors, security: securityView, deadImports: deadImportsView });
      this.deps.log.info(`Gate do projeto: ${summary} (rodou: ${gate.ran.join(", ") || "nada"}${architectureErrors.length ? ", camadas" : ""}${dodBlocksAll ? ", definição-de-pronto" : ""}${security ? ", segurança" : ""}; pulou: ${gate.skipped.join(", ") || "nada"})`);
      return {
        summary: { ...gate, summary, architectureErrors, dodErrors, securityErrors, securityAdvisories, deadImportAdvisories, a11yAdvisories },
        state: { lastGateRun, contractUnverified: contractUnverifiedFlag, contractUnverifiedHard: contractUnverifiedHardFlag },
      };
    } catch (e) {
      // Falha do PRÓPRIO gate (temp/exec) nunca deve travar a entrega — degrada para consultivo. MAS
      // para a POLÍTICA, gate que não rodou = contrato não verificado (senão quebrar o gate seria o
      // bypass): o flag CRU fica ligado em Python e o "Re-verificar contrato" permite re-tentar.
      this.deps.log.warn("Gate do projeto falhou ao executar — seguindo consultivo", e);
      const contractUnverifiedHardFlag = contractUnverified(language, false, true);
      const contractBlocked = contractUnverifiedHardFlag && this.deps.config.blockUnverifiedContract();
      this.deps.post({ type: "project/gate", advisory: true, partial: false, requiresContractConfirm: false, contractBlocked, summary: contractBlocked ? hostT("gate.couldntRun.policy") : hostT("gate.couldntRun"), files: [], projectErrors: [], dod: [], security: [], deadImports: [] });
      // Não trava o Aplicar por CONFIRMAÇÃO (retrocompat): contractUnverified=false; o Hard segue a política.
      return { summary: null, state: { lastGateRun, contractUnverified: false, contractUnverifiedHard: contractUnverifiedHardFlag } };
    } finally {
      if (root) await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
      this.deps.obs.record({ type: "phase.timing", taskId: task.taskId, phase: "gate", durationMs: Date.now() - gateStart });
    }
  }

  // Materializa as propostas de arquivo numa árvore temp (cada path CONTIDO na raiz via safeWorkspacePath)
  // e semeia os __init__.py sintéticos para os imports cross-file resolverem. COMPARTILHADO pelo gate
  // estático (compileall/mypy) e pelo smoke test (pytest). Retorna os caminhos relativos materializados.
  private async writeProjectTree(root: string, props: { proposal: { filePath: string; modified: string } }[], language: ProjectLanguage = "python"): Promise<string[]> {
    const relPaths: string[] = [];
    for (const e of props) {
      const abs = safeWorkspacePath(root, e.proposal.filePath);
      if (!abs) continue;
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, e.proposal.modified, "utf8");
      relPaths.push(normGatePath(e.proposal.filePath));
    }
    for (const dir of syntheticInitDirs(relPaths, language)) {
      const abs = safeWorkspacePath(root, `${dir}/__init__.py`);
      if (!abs) continue;
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, "", "utf8");
    }
    return relPaths;
  }

  // Smoke test ADVISORY (P4): depois do gate estático verde, tenta RODAR a suíte gerada (pytest) contra a
  // árvore materializada usando o VENV do workspace — o sinal "de fato roda", além de "compila e tipa". As
  // deps de terceiros resolvem do venv; os módulos do projeto, da árvore temp (cwd). NUNCA bloqueia o
  // Aplicar e NUNCA instala nada (egress deny-by-default): sem venv/pytest/deps, degrada para advisory.
  // Respeita forge.test.enabled e só roda quando há suíte gerada (test_*.py / *_test.py). O `taskId`
  // ancora o aviso na resposta da geração.
  async runProjectSmoke(language: ProjectLanguage, taskId: string): Promise<void> {
    if (language !== "python" || !this.deps.config.test().enabled) return;
    const task = this.deps.currentTask();
    if (!task) return;
    const props = [...task.proposals.values()].filter((e) => !e.proposal.cell && !e.proposal.partial);
    const hasTests = props.some((e) => /(^|\/)test_[^/]*\.py$|_test\.py$/i.test(normGatePath(e.proposal.filePath)));
    if (!hasTests) return; // sem suíte gerada — nada a rodar
    const ws = this.deps.workspaceRoot();
    const venvPy = ws ? findVenvPython(ws, process.platform === "win32", existsSync, process.env.VIRTUAL_ENV) : undefined;
    if (!venvPy) {
      this.deps.post({ type: "stream/notice", taskId, level: "info", message: hostT("notice.smoke.noVenv") });
      return;
    }
    let root: string | undefined;
    try {
      root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-smoke-"));
      await this.writeProjectTree(root, props);
      const timeoutMs = this.deps.config.run().timeoutSeconds * 1000;
      // -p no:cacheprovider: não escreve .pytest_cache na árvore temp (que é descartada mesmo).
      const result = await runFileCheck(
        { id: "smoke:pytest", label: "pytest (smoke)", gate: false },
        venvPy,
        ["-m", "pytest", "-q", "-p", "no:cacheprovider"],
        { cwd: root, timeoutMs, outputCap: 8000 }
      );
      const verdict = summarizeSmoke(result);
      this.deps.post({ type: "stream/notice", taskId, level: verdict.level, message: verdict.message });
      this.deps.log.info(`Smoke test do projeto: ${verdict.message}`);
    } catch (e) {
      // Falha do PRÓPRIO smoke (temp/exec) nunca trava a entrega — é advisory.
      this.deps.log.warn("Smoke test do projeto falhou ao executar — ignorado (advisory)", e);
    } finally {
      if (root) await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // Reconciliação de dependências (P4): depois do gate, confere se o requirements.txt GERADO declara os
  // pacotes que o código gerado de fato IMPORTA e acrescenta os AUSENTES à proposta do manifesto. O DoD
  // garante que o manifesto EXISTE; isto garante que está CORRETO — o gap que faz "instala e roda" falhar.
  // Auto-corrige a proposta (idempotente/conservador via reconcileRequirements) e re-posta o cartão
  // (stream/proposalUpdate, o mesmo do auto-reparo). pyproject-only fica de fora (editar TOML é frágil; o
  // Preparar ambiente ainda completa no install). PURO na decisão (reconcileRequirements); aqui só coleta e
  // reage. Nunca bloqueia. Chamado só com o projeto COMPLETO.
  reconcile(): void {
    if (!this.deps.config.reconcileDependencies()) return;
    const task = this.deps.currentTask();
    if (!task) return;
    // Exclui células e parciais (o parcial pode ter imports cortados — reconciliar sobre ele erraria).
    const props = [...task.proposals.values()].filter((e) => !e.proposal.cell && !e.proposal.partial);
    const isReqTxt = (p: string) => /(^|\/)requirements[^/]*\.txt$/i.test(p) || /(^|\/)requirements\/[^/]+\.txt$/i.test(p);
    const manifest = props.find((e) => isReqTxt(normGatePath(e.proposal.filePath)));
    if (!manifest) return; // sem requirements.txt (pyproject-only / ausente) → fora do escopo desta reconciliação
    const pyFiles = props
      .filter((e) => e.proposal.filePath.toLowerCase().endsWith(".py"))
      .map((e) => ({ path: normGatePath(e.proposal.filePath), content: e.proposal.modified }));
    if (pyFiles.length === 0) return; // nada de Python → nada a reconciliar
    // Caminhos do projeto INTEIRO para os módulos locais: propostas desta rodada + arquivos já aplicados
    // (só o path basta para reconhecer um módulo local — sem I/O).
    const projectPaths = [
      ...props.map((e) => normGatePath(e.proposal.filePath)),
      ...(this.deps.projectSession()?.files ?? []).filter((f) => f.status === "applied").map((f) => normGatePath(f.path)),
    ];
    let content: string;
    let added: string[];
    try {
      ({ content, added } = reconcileRequirements(pyFiles, projectPaths, manifest.proposal.modified));
    } catch (e) {
      this.deps.log.warn("Reconciliação de dependências falhou — seguindo (não bloqueia)", e);
      return;
    }
    if (added.length === 0) return; // manifesto já coerente
    // Auto-corrige a proposta NO LUGAR (mesmo id) e re-posta o cartão para refletir o arquivo corrigido.
    manifest.proposal = { ...manifest.proposal, modified: content };
    this.deps.post({ type: "stream/proposalUpdate", proposal: manifest.proposal });
    this.deps.post({ type: "notice", level: "info", message: hostT("notice.deps.reconciled", { path: manifest.proposal.filePath, count: added.length, packages: added.join(", ") }) });
    this.deps.log.info(`Reconciliação: +${added.length} em ${manifest.proposal.filePath} (${added.join(", ")})`);
  }

  // Resolve um comando de Python utilizável para o gate: venv do workspace primeiro (maior chance de ter
  // mypy + deps), senão sonda `python`/`python3`/`py`. null → nenhum encontrado (o gate ficará consultivo
  // via ENOENT). Uma sondagem barata evita rodar compileall/mypy contra um comando inexistente.
  private async resolveGatePython(): Promise<string> {
    const ws = this.deps.workspaceRoot();
    const isWin = process.platform === "win32";
    const venv = ws ? findVenvPython(ws, isWin, existsSync, process.env.VIRTUAL_ENV) : undefined;
    const candidates = [venv, "python", "python3", "py"].filter((c): c is string => !!c);
    for (const cand of candidates) {
      const probe = await runFileCheck({ id: "probe", label: "python", gate: false }, cand, ["--version"], { timeoutMs: 15_000 });
      if (probe.status !== "skipped") return cand; // achou (rodou; ENOENT vira skipped)
    }
    return candidates[0] ?? "python"; // nada respondeu: usa o 1º e deixa o ENOENT tornar o gate consultivo
  }

  // Resolve o tsc para o gate TypeScript (P4): o typescript do WORKSPACE (node_modules/typescript/lib/tsc.js),
  // rodado via `node <tsc.js>` — o execFile (sem shell) não invoca um .cmd de forma confiável no Windows, e
  // `node` é um .exe do PATH. Fallback: `tsc` do PATH (global). Nenhum → undefined (gate consultivo). Só
  // sondagem barata; NÃO instala nada (não poluímos o projeto do dev).
  private async resolveGateTsc(): Promise<{ cmd: string; baseArgs: string[] } | undefined> {
    const tscJs = findWorkspaceTscJs(this.deps.workspaceRoot(), existsSync);
    if (tscJs) {
      const probe = await runFileCheck({ id: "probe", label: "tsc", gate: false }, "node", [tscJs, "--version"], { timeoutMs: 15_000 });
      if (probe.status === "ok") return { cmd: "node", baseArgs: [tscJs] };
    }
    const globalTsc = process.platform === "win32" ? "tsc.cmd" : "tsc";
    const probe = await runFileCheck({ id: "probe", label: "tsc", gate: false }, globalTsc, ["--version"], { timeoutMs: 15_000 });
    if (probe.status === "ok") return { cmd: globalTsc, baseArgs: [] };
    return undefined;
  }

  // Gate TypeScript (P4): materializa um tsconfig mínimo na árvore temp e roda `tsc --noEmit`. Classifica: erro
  // de SINTAXE (TS1xxx) BLOQUEIA (o arquivo nem parseia); erro de TIPO (TS2xxx+) é ADVISORY — sem node_modules
  // no temp o tsc é ruidoso (deps/tipos ausentes → cascata), então type-drift vira aviso, não bloqueio (decisão
  // (A)). tsc ausente/inconclusivo → check "skipped" (consultivo, como o mypy). O ruído de import BARE já é
  // filtrado em parseTscErrors; o de import RELATIVO (drift interno) é mantido.
  private async runTsChecks(root: string, timeoutMs: number, outputCap: number, knownFiles: Set<string>): Promise<{ checks: GateCheckResult[]; advisories: string[] }> {
    const tsc = await this.resolveGateTsc();
    if (!tsc) {
      return { checks: [{ result: { id: "gate:tsc", label: "tsc", status: "skipped", gate: true, output: "", reason: "tsc não encontrado (instale typescript no workspace) — gate consultivo" }, errors: new Map() }], advisories: [] };
    }
    await fs.writeFile(path.join(root, "tsconfig.gate.json"), buildGateTsconfig(), "utf8");
    const raw = await runFileCheck(
      { id: "gate:tsc", label: "tsc", gate: true },
      tsc.cmd,
      [...tsc.baseArgs, "--noEmit", "--pretty", "false", "-p", "tsconfig.gate.json"],
      { cwd: root, timeoutMs, outputCap }
    );
    if (tscUnavailable(raw)) {
      return { checks: [{ result: { ...raw, status: "skipped", reason: "tsc não pôde rodar — gate consultivo" }, errors: new Map() }], advisories: [] };
    }
    const errors = parseTscErrors(raw.output, root);
    const syntax = errors.filter((e) => isTscSyntaxError(e.code));
    // #05: SINTAXE (TS1xxx) + CONTRATO (TS2307 de import relativo — módulo-fantasma) BLOQUEIAM; o resto dos
    // erros de tipo segue ADVISORY (cascata de tipo sem node_modules). parseTscErrors já garante que o TS2307
    // que chega aqui é de import RELATIVO (o BARE de terceiros foi filtrado) → drift interno real, seguro de
    // bloquear (o análogo TS do import-fantasma que o mypy bloqueia no Python).
    const contract = errors.filter((e) => isBlockingTscContract(e, knownFiles));
    const advisory = errors.filter((e) => !isTscSyntaxError(e.code) && !isBlockingTscContract(e, knownFiles));
    const blocking = [...syntax, ...contract];
    return {
      checks: [{ result: { ...raw, label: "tsc (sintaxe/contrato)", status: blocking.length > 0 ? "failed" : "ok" }, errors: tscErrorsToMap(blocking) }],
      advisories: advisory.map((e) => `${e.path}:${e.line} — [${e.code}] ${e.message}`),
    };
  }

  // Resolve o ferramental Go para o gate (P4): sonda `go version` e `gofmt`. `go`/`gofmt` são .exe REAIS no
  // Windows (sem a armadilha do .cmd/EINVAL que derrubava o gate TS). undefined → nenhum go (gate consultivo);
  // gofmt ausente (raríssimo — vem junto do go) → sem o gate de sintaxe, só o advisory. Só sondagem barata.
  private async resolveGateGo(): Promise<{ go: string; gofmt?: string } | undefined> {
    const goProbe = await runFileCheck({ id: "probe", label: "go", gate: false }, "go", ["version"], { timeoutMs: 15_000 });
    if (goProbe.status !== "ok") return undefined; // ENOENT/timeout → sem go
    // `gofmt -h` imprime o uso e sai != 0 (→ "failed"); ENOENT (não instalado) → "skipped". Presente iff != skipped.
    const gofmtProbe = await runFileCheck({ id: "probe", label: "gofmt", gate: false }, "gofmt", ["-h"], { timeoutMs: 15_000 });
    return { go: "go", gofmt: gofmtProbe.status === "skipped" ? undefined : "gofmt" };
  }

  // Gate Go (P4): gofmt (SINTAXE, bloqueia) + go build (compilação/drift, advisory). O gofmt só PARSEIA — todo
  // erro dele é sintaxe pura e NUNCA falso-bloqueia por dep ausente (offline, dep-free). O go build roda OFFLINE
  // (GOPROXY=off), com o ruído de deps de terceiros filtrado (parseGoBuildErrors), e NUNCA bloqueia (decisão
  // (A), como o tipo no tsc). go ausente → check skipped (consultivo, como o mypy/tsc).
  private async runGoChecks(root: string, timeoutMs: number, outputCap: number): Promise<{ checks: GateCheckResult[]; advisories: string[] }> {
    const go = await this.resolveGateGo();
    if (!go) {
      return { checks: [{ result: { id: "gate:gofmt", label: "gofmt", status: "skipped", gate: true, output: "", reason: "go/gofmt não encontrado (instale o Go) — gate consultivo" }, errors: new Map() }], advisories: [] };
    }
    // 1) SINTAXE (bloqueia): gofmt -l -e . — parse-only, offline, dep-free. `-l` faz o stdout listar só NOMES
    // de arquivo (ignorados pelo parser); os erros de sintaxe saem no stderr. Sem gofmt → só o advisory roda.
    let fmtCheck: GateCheckResult;
    if (go.gofmt) {
      const fmt = await runFileCheck({ id: "gate:gofmt", label: "gofmt (sintaxe)", gate: true }, go.gofmt, ["-l", "-e", "."], { cwd: root, timeoutMs, outputCap });
      const fmtErrors = fmt.status === "failed" ? parseGofmtErrors(fmt.output, root) : new Map<string, string[]>();
      // gofmt que "reprovou" SEM erro atribuível é anomalia de ambiente (I/O), não sintaxe → consultivo em vez
      // de bloqueio amplo (mesmo espírito do mypy-abort). Um erro de sintaxe REAL sempre traz `arquivo:linha`.
      fmtCheck =
        fmt.status === "failed" && fmtErrors.size === 0
          ? { result: { ...fmt, status: "skipped", reason: "gofmt não pôde analisar (I/O) — gate consultivo" }, errors: new Map() }
          : { result: { ...fmt, status: fmtErrors.size > 0 ? "failed" : "ok" }, errors: fmtErrors };
    } else {
      fmtCheck = { result: { id: "gate:gofmt", label: "gofmt", status: "skipped", gate: true, output: "", reason: "gofmt não encontrado — gate de sintaxe consultivo" }, errors: new Map() };
    }
    // 2) COMPILAÇÃO/DRIFT (advisory): go build ./... offline; o ruído de deps de terceiros é filtrado.
    const advisories = await this.runGoBuildAdvisory(go.go, root, timeoutMs, outputCap);
    return { checks: [fmtCheck], advisories };
  }

  // Advisory de compilação/drift do Go: `go build ./...` OFFLINE (GOPROXY=off — nunca baixa deps; respeita o
  // egress deny-by-default), com um go.mod garantido na raiz (o GERADO, se houver; senão um mínimo sintético).
  // O ruído de deps de terceiros ausentes é filtrado; o que sobra (símbolo indefinido, import/var não usados —
  // em Go são ERRO de compilação) é drift REAL, mostrado como aviso. NUNCA bloqueia. Falha → advisory vazio.
  private async runGoBuildAdvisory(go: string, root: string, timeoutMs: number, outputCap: number): Promise<string[]> {
    try {
      // go build ./... exige um módulo: usa o go.mod GERADO se veio na árvore; senão sintetiza um mínimo (o
      // módulo sintético não resolve os imports internos com prefixo do módulo real, mas o advisory tolera).
      if (!existsSync(path.join(root, "go.mod"))) {
        await fs.writeFile(path.join(root, "go.mod"), "module forgegate\n\ngo 1.21\n", "utf8");
      }
      // OFFLINE e determinístico: GOPROXY=off (sem rede), GOFLAGS=-mod=mod (não exige go.sum), GOWORK=off (ignora
      // um go.work ancestral), GOTOOLCHAIN=local (não baixa uma toolchain se o go.mod pedir versão maior),
      // CGO_ENABLED=0 (nunca invoca o compilador C: fecha o vetor de exec por cgo/#cgo em código gerado e evita
      // o ruído "gcc not found" no Windows). O go build NÃO executa o código (só compila — distinto do smoke).
      const env = { ...process.env, GOPROXY: "off", GOFLAGS: "-mod=mod", GOWORK: "off", GOTOOLCHAIN: "local", GO111MODULE: "on", CGO_ENABLED: "0" };
      const build = await runFileCheck({ id: "gate:gobuild", label: "go build", gate: false }, go, ["build", "./..."], { cwd: root, timeoutMs, outputCap, env });
      if (build.status !== "failed") return []; // ok (compilou) ou skipped (inconclusivo) → sem advisory
      return parseGoBuildErrors(build.output, root).map((e) => `${e.path}:${e.line} — ${e.message}`);
    } catch (e) {
      this.deps.log.warn("Gate Go: advisory do go build falhou — seguindo sem aviso", e);
      return [];
    }
  }

  // Onda 1.5: garante o mypy no venv do workspace (best-effort). O gate só pega o DRIFT de contrato
  // cross-file via mypy; compileall só vê sintaxe. Sem mypy o gate fica "parcial" e não bloqueia — então
  // um projeto que não roda (import fantasma) passaria. Instala SÓ quando o python do gate É o venv do
  // workspace (nunca polui o python global). Falha/offline → não instala, gate degrada para "parcial".
  private async ensureGateMypy(py: string): Promise<void> {
    try {
      const ws = this.deps.workspaceRoot();
      if (!ws) return;
      const isWin = process.platform === "win32";
      const venv = findVenvPython(ws, isWin, existsSync, process.env.VIRTUAL_ENV);
      if (!venv || py !== venv) return; // só num venv do workspace; nunca no python global/system
      const probe = await runFileCheck({ id: "probe", label: "mypy", gate: false }, py, ["-m", "mypy", "--version"], { timeoutMs: 15_000 });
      if (probe.status === "ok") return; // mypy já disponível no venv
      if (this.deps.runService.isBusy()) return; // não atropela uma execução em andamento
      // Best-effort: se a instalação não iniciar/falhar (offline, sem índice pip), o gate fica "parcial".
      await this.deps.runService.runCommand(hostT("run.label.gateMypy"), buildMypyInstall(venv), this.deps.config.env().timeoutSeconds * 1000);
    } catch (e) {
      this.deps.log.warn("Gate: não consegui garantir o mypy no venv — seguindo (o gate pode ficar parcial)", e);
    }
  }

  // Garante o bandit no venv do workspace (best-effort, espelho do ensureGateMypy). Só num venv do
  // workspace (nunca no python global/system). Falha/offline → não instala; o gate de segurança fica
  // consultivo (não bloqueia). Chamado só quando forge.gate.security != "off".
  private async ensureGateBandit(py: string): Promise<void> {
    try {
      const ws = this.deps.workspaceRoot();
      if (!ws) return;
      const isWin = process.platform === "win32";
      const venv = findVenvPython(ws, isWin, existsSync, process.env.VIRTUAL_ENV);
      if (!venv || py !== venv) return; // só num venv do workspace; nunca no python global/system
      const probe = await runFileCheck({ id: "probe", label: "bandit", gate: false }, py, ["-m", "bandit", "--version"], { timeoutMs: 15_000 });
      if (probe.status === "ok") return; // bandit já disponível no venv
      if (this.deps.runService.isBusy()) return; // não atropela uma execução em andamento
      await this.deps.runService.runCommand(hostT("run.label.gateBandit"), buildBanditInstall(venv), this.deps.config.env().timeoutSeconds * 1000);
    } catch (e) {
      this.deps.log.warn("Gate: não consegui garantir o bandit no venv — seguindo (segurança consultiva)", e);
    }
  }

  // Garante o ruff no venv do workspace (best-effort, espelho do ensureGateBandit). Só num venv do workspace
  // (nunca no python global/system). Falha/offline → não instala; o gate de imports mortos fica consultivo.
  // Chamado só quando forge.gate.deadImports != false. (F-18)
  private async ensureGateRuff(py: string): Promise<void> {
    try {
      const ws = this.deps.workspaceRoot();
      if (!ws) return;
      const isWin = process.platform === "win32";
      const venv = findVenvPython(ws, isWin, existsSync, process.env.VIRTUAL_ENV);
      if (!venv || py !== venv) return; // só num venv do workspace; nunca no python global/system
      const probe = await runFileCheck({ id: "probe", label: "ruff", gate: false }, py, ["-m", "ruff", "--version"], { timeoutMs: 15_000 });
      if (probe.status === "ok") return; // ruff já disponível no venv
      if (this.deps.runService.isBusy()) return; // não atropela uma execução em andamento
      await this.deps.runService.runCommand(hostT("run.label.gateRuff"), buildRuffInstall(venv), this.deps.config.env().timeoutSeconds * 1000);
    } catch (e) {
      this.deps.log.warn("Gate: não consegui garantir o ruff no venv — seguindo (imports mortos consultivo)", e);
    }
  }

  // Gate de SEGURANÇA (P2): roda o bandit (SAST) sobre a árvore temp materializada e classifica os achados
  // de forma conservadora (só severidade+confiança ALTAS bloqueiam). bandit ausente/sem relatório → null
  // (fail-open: nada bloqueia). Análise por AST — NÃO executa o código gerado (distinto do smoke test).
  private async runSecurityScan(py: string, root: string, mode: SecurityMode): Promise<{ blocking: { path: string; errors: string[] }[]; advisories: string[] } | null> {
    // O relatório vai para um ARQUIVO (`-o`), NÃO para o stdout. Isso o torna imune a: (1) fusão de
    // stdout+stderr do runner — um aviso do interpretador com `{`/`}` quebraria o recorte do JSON; (2)
    // truncamento por outputCap; (3) frases benignas do código escaneado ("no such file or directory")
    // confundindo a heurística de disponibilidade. Achados da revisão adversarial. O `.json` fica DENTRO da
    // árvore temp (descartada no finally) e o bandit só varre `.py`, então não se escaneia a si mesmo.
    const reportPath = path.join(root, ".forge-bandit-report.json");
    // -q silencia o progresso; -f json + -o escreve o relatório; -r . varre a árvore. Exit 1 quando ACHA
    // issues é NORMAL — o veredito vem do relatório, não do código de saída.
    const result = await runFileCheck(
      { id: "gate:bandit", label: "bandit", gate: false },
      py,
      ["-m", "bandit", "-r", ".", "-f", "json", "-o", reportPath, "-q"],
      { cwd: root, timeoutMs: 120_000, outputCap: 8_000 }
    );
    if (result.status === "skipped") return null; // ENOENT (sem python) / timeout → inconclusivo (fail-open)
    // Relatório ausente/ilegível (bandit não instalado → não escreve arquivo; ou crash) → null (fail-open).
    // parseBanditReport distingue "sem relatório" (null) de "rodou e nada achou" ([]) — um relatório
    // truncado nunca é confundido com varredura limpa.
    const reportRaw = await fs.readFile(reportPath, "utf8").catch(() => "");
    const findings = parseBanditReport(reportRaw);
    if (findings === null) return null;
    // bandit emite caminhos relativos ao cwd (=root) por causa do `-r .`; o ramo absoluto é defensivo.
    const rel = (p: string): string => {
      const raw = (p ?? "").trim();
      return raw && (path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)) ? normGatePath(path.relative(root, raw)) : normGatePath(raw);
    };
    return splitSecurityFindings(findings.map((f) => ({ ...f, path: rel(f.path) })), mode);
  }

  // Gate de IMPORTS MORTOS (F-18): roda o ruff (regra F401) sobre a árvore temp e devolve linhas ADVISORY
  // (nunca bloqueia — não há split de bloqueio). Análise por AST — NÃO executa o código. ruff ausente/sem
  // relatório → null (fail-open). Espelha o runSecurityScan: relatório num ARQUIVO (`-o`), veredito do
  // relatório e NÃO do exit code (ruff sai 1 quando ACHA algo — normal); --isolated ignora ruff.toml/pyproject
  // do dev (hermético); --select F401 fixa a regra.
  private async runDeadImportScan(py: string, root: string): Promise<string[] | null> {
    const reportPath = path.join(root, ".forge-ruff-report.json");
    const result = await runFileCheck(
      { id: "gate:ruff", label: "ruff", gate: false },
      py,
      ["-m", "ruff", "check", "--isolated", "--output-format", "json", "--select", "F401", "-o", reportPath, "-q", "."],
      { cwd: root, timeoutMs: 120_000, outputCap: 8_000 }
    );
    if (result.status === "skipped") return null; // ENOENT (sem python) / timeout → inconclusivo (fail-open)
    const reportRaw = await fs.readFile(reportPath, "utf8").catch(() => "");
    const findings = parseRuffReport(reportRaw);
    if (findings === null) return null; // relatório ausente/truncado → indisponível (fail-open)
    // O ruff emite caminhos ABSOLUTOS (diferente do bandit, relativo por causa do `-r .`) → normaliza p/
    // relativo à raiz do gate (casa com os paths das propostas). Mesmo normalizador do runSecurityScan.
    const rel = (p: string): string => {
      const raw = (p ?? "").trim();
      return raw && (path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)) ? normGatePath(path.relative(root, raw)) : normGatePath(raw);
    };
    return ruffAdvisories(findings.map((f) => ({ ...f, path: rel(f.path) })));
  }
}
