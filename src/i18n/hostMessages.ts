import type { Locale } from "../shared/locale";

// Catálogo de mensagens do HOST por locale. Espelha a camada da webview (pt-BR é a FONTE completa; en é
// override — chave ausente cai para pt-BR). Existe uma camada PRÓPRIA (em vez de vscode.l10n) porque o
// produto é pt-BR-FIRST: o vscode.l10n é arquiteturalmente incapaz de servir INGLÊS a partir de uma
// fonte pt-BR (o inglês é a língua-DEFAULT do VSCode, que curto-circuita o carregamento do bundle — um
// usuário en receberia a string-fonte pt-BR). Uma camada própria, lida de vscode.env.language, escolhe o
// catálogo sem esse curto-circuito. Chaves estáveis (namespace.pontos), sem acento; o TEXTO é o que traduz.
//
// Namespaces: notice.* (toasts), dialog.* (diálogos nativos), bp.* (blueprint do Modo Projeto),
// charter.* (wizard), gate.* (resumos do quality gate), smoke.* (smoke test advisory), card.* (dataCards
// montados no Controller), role.* (papéis do picker), preset.note.* / rag.* / search.* (state).
// NOTA: nos textos en, comandos da paleta usam o LABEL en (/connections, /run-sql, /impact, /summarize) —
// é o que a paleta mostra a esse usuário (id/aliases garantem que as duas formas executam).
export type HostMessageKey =
  | "dialog.skillsReindexed"
  | "dialog.signedOut"
  | "notice.openFolder.rules"
  | "notice.rule.exists"
  | "notice.charterSaved"
  | "notice.noBlueprint"
  | "preset.note.hubgpu"
  | "preset.note.openai"
  | "preset.note.anthropic"
  | "rag.test.disabled"
  | "rag.test.lexical"
  | "rag.test.ok"
  | "search.label"
  // Abra uma pasta…
  | "notice.openFolder.profile"
  | "notice.openFolder.role"
  | "notice.openFolder.charter"
  | "notice.openFolder.attach"
  | "notice.openFolder.apply"
  | "notice.openFolder.codeBlock"
  | "notice.openFolder.tests"
  | "notice.openFolder.env"
  // Perfil/regras
  | "notice.rule.added"
  // Charter
  | "notice.charter.fillReqs"
  | "charter.err.truncated"
  | "charter.err.empty"
  | "charter.err.license"
  | "charter.err.provider"
  | "charter.warn.error"
  | "charter.warn.truncatedAfterContinue"
  | "charter.warn.truncated"
  // Blueprint (Modo Projeto)
  | "bp.err.license"
  | "bp.err.email"
  | "bp.err.provider"
  | "bp.err.genLicense"
  | "bp.err.genEmail"
  | "bp.err.truncated"
  | "bp.err.noArray"
  | "bp.err.empty"
  | "bp.err.detail"
  | "bp.err.head"
  | "bp.err.noneGenerated"
  | "bp.step.analyze"
  | "bp.step.reasoning"
  | "bp.step.order"
  | "bp.step.convert"
  | "bp.step.converting"
  | "bp.step.receiving"
  | "bp.warn.truncated"
  | "bp.warn.salvaged"
  // Projeto (gate/reparo/scaffold/deps)
  | "notice.project.autoRepair"
  | "notice.project.architecture"
  | "notice.project.dod"
  | "notice.project.security"
  | "notice.project.incomplete"
  | "notice.project.scaffold"
  | "notice.project.initCreated"
  | "notice.regate.nothing"
  | "notice.regate.running"
  | "notice.deps.reconciled"
  | "notice.smoke.noVenv"
  // Aplicar
  | "notice.applyAll"
  | "notice.applyAll.applied"
  | "notice.applyAll.blocked"
  | "notice.applyAll.blockedHint"
  | "notice.applyAll.partial"
  | "notice.contractPolicy.applyAll"
  | "notice.contractPolicy.applyFile"
  | "notice.apply.forced"
  | "notice.apply.outsideWorkspace"
  | "notice.invalidPath"
  | "notice.proposal.expired"
  | "notice.proposal.copied"
  // Trecho→arquivo / células
  | "notice.codeBlock.needPath"
  | "notice.codeBlock.needReply"
  | "notice.cell.openFailed"
  | "notice.cell.applyFailed"
  | "notice.cell.applyFirst"
  | "notice.cell.runFailed"
  // Licença/provedor/e-mail/contexto
  | "notice.license.noPubkey"
  | "notice.license.refused"
  | "notice.license.activated"
  | "notice.license.required"
  | "notice.email.invalid"
  | "notice.email.saved"
  | "notice.email.required"
  | "notice.provider.configured"
  | "notice.provider.none"
  | "notice.provider.beforeMaxOutput"
  | "notice.context.cleared"
  | "notice.context.provider"
  | "notice.webBlocked"
  | "notice.langfuseSaved"
  // Resumir
  | "notice.summarize.empty"
  | "notice.summarize.license"
  | "notice.summarize.provider"
  | "notice.summarize.failed"
  | "notice.summarize.emptyResult"
  | "notice.summarize.drift"
  // Anexos/OCR/busca
  | "notice.attach.unreadable"
  | "notice.attach.binary"
  | "notice.attach.selectEditor"
  | "notice.attach.noTerminal"
  | "notice.attach.selectTerminal"
  | "notice.ocr.badImage"
  | "notice.ocr.tooBig"
  | "notice.ocr.inFlight"
  | "notice.ocr.running"
  | "notice.ocr.noText"
  | "notice.ocr.prepFailed"
  | "notice.ocr.needTesseract"
  | "notice.ocr.failed"
  | "notice.ocr.tessdataHint"
  | "notice.search.unconfigured"
  | "notice.search.running"
  | "notice.search.failed"
  // Testes/ambiente
  | "notice.tests.disabled"
  | "notice.run.busy"
  | "notice.tests.runDisabled"
  | "notice.tests.cancelled"
  | "notice.tests.busyLater"
  | "notice.env.venvFailed"
  | "notice.tests.installNotStarted"
  | "notice.tests.installFailed"
  | "notice.env.reqIncremented"
  | "notice.env.pyprojectNoBuild"
  | "notice.env.reqGenerated"
  | "notice.env.noDeps"
  | "run.label.env"
  | "run.label.pytestInstall"
  | "run.label.gateMypy"
  | "run.label.gateBandit"
  | "run.label.cell"
  | "run.label.tests"
  | "run.cell.noOutput"
  | "notice.gate.blockedApply"
  | "sql.writeCancelled"
  // Diagnóstico/revisão
  | "notice.diag.exportFailed"
  | "notice.review.license"
  | "notice.review.email"
  | "notice.review.none"
  // RAG
  | "rag.capped"
  // Gate (resumos)
  | "gate.py.advisory"
  | "gate.py.failed"
  | "gate.py.unattributed"
  | "gate.py.ok"
  | "gate.py.partial"
  | "gate.go.advisory"
  | "gate.go.failed"
  | "gate.go.ok"
  | "gate.java"
  | "gate.dodIncomplete"
  | "gate.alsoBlocked"
  | "gate.blocked"
  | "gate.securitySuffix"
  | "gate.part.compile"
  | "gate.part.syntaxGo"
  | "gate.part.arch"
  | "gate.part.security"
  | "gate.tscSuffix"
  | "gate.goSuffix"
  | "gate.moreSecurity"
  | "gate.couldntRun.policy"
  | "gate.couldntRun"
  // Smoke test (advisory)
  | "smoke.timeout"
  | "smoke.noPython"
  | "smoke.passed"
  | "smoke.passedAll"
  | "smoke.failed"
  | "smoke.none"
  | "smoke.noPytest"
  | "smoke.importFailed"
  | "smoke.notPassed"
  // Diálogos nativos
  | "dialog.ragReindexed"
  | "dialog.role.placeholder"
  | "role.cientista"
  | "role.engDados"
  | "role.engMl"
  | "role.engIa"
  | "role.engSoftware"
  | "dialog.maxOutput.title"
  | "dialog.maxOutput.placeholder"
  | "dialog.maxOutput.auto"
  | "dialog.maxOutput.tokens"
  | "dialog.maxOutput.current"
  | "dialog.maxOutput.autoDesc"
  | "dialog.maxOutput.loweredDesc"
  | "dialog.langfuse.prompt"
  | "dialog.search.prompt"
  | "dialog.search.placeholder"
  | "dialog.attach.placeholder"
  | "dialog.run.openFile"
  | "dialog.pytest.installVenv"
  | "dialog.pytest.createVenv"
  | "dialog.pytest.installBtn"
  | "dialog.cancel"
  | "dialog.deps.detected"
  | "dialog.deps.addBtn"
  | "dialog.deps.onlyListedBtn"
  | "dialog.diag.exported"
  // Cards montados no Controller
  | "card.git.openFolder"
  | "card.git.untrusted"
  | "card.git.nothingToCommit"
  | "card.git.cancelled"
  | "card.git.failed"
  | "card.conn.header"
  | "card.conn.none"
  | "card.conn.cols"
  | "card.conn.rw"
  | "card.conn.ro"
  | "card.conn.footer"
  | "card.sql.openFile"
  | "card.sql.connNotExists"
  | "card.sql.connUnconfigured"
  | "card.sql.frame"
  | "card.sql.resultTitle"
  | "card.cost.none"
  | "card.cost.previewTitle"
  | "card.cost.previewFrame"
  | "card.cost.frame"
  | "card.schema.none"
  | "card.schema.frame"
  | "card.schema.invFailed"
  | "card.schema.ok"
  | "card.parity.frame"
  | "card.parity.connNotExists"
  | "card.parity.profileFailed"
  | "card.data.unknown"
  | "card.data.failed"
  | "card.impact.frame"
  | "card.impact.noManifest"
  | "card.impact.notFound"
  | "card.impact.notFoundSug"
  | "card.impact.openModel"
  // Git (renderers puros — gitCommands.ts)
  | "git.msg.required"
  | "git.msg.tooLong"
  | "git.st.modified"
  | "git.st.added"
  | "git.st.deleted"
  | "git.st.renamed"
  | "git.st.copied"
  | "git.st.conflict"
  | "git.st.new"
  | "git.st.untracked"
  | "git.noBranch"
  | "git.ahead"
  | "git.behind"
  | "git.clean"
  | "git.cols"
  | "git.more"
  | "git.commitHint"
  | "git.diff.empty"
  | "git.diff.truncated"
  | "git.log.empty"
  | "git.log.cols"
  | "git.commit.ok"
  | "git.commit.fail"
  | "git.unavailable"
  // Warehouse (sqlRunners + WarehouseService)
  | "wh.err.oracleConnect"
  | "wh.err.psqlConnect"
  | "wh.err.objectStorage"
  | "wh.err.unknownKind"
  | "wh.err.costSingle"
  | "wh.err.costSingleShort"
  | "wh.err.costUnavailable"
  | "wh.result.noOutput"
  | "wh.result.capped"
  | "wh.result.masked"
  | "wh.pwd.title"
  | "wh.pwd.prompt"
  | "wh.err.unsafeField"
  | "wh.err.unsafeSchema"
  | "wh.err.connNotExists"
  | "wh.err.noneConfigured"
  | "wh.err.noneConfiguredShort"
  | "wh.err.costReadonly"
  | "wh.err.toolMissing"
  | "wh.err.spawnFailed"
  | "wh.hint.sqlcl"
  | "wh.hint.duckdb"
  | "wh.hint.default"
  | "wh.err.schemaBigQuery"
  | "wh.err.schemaUnavailable"
  | "val.label.sqlSecurity"
  | "val.label.sqlAntipatterns"
  | "val.label.sqlSchema"
  // Paridade
  | "par.absent"
  | "par.head"
  | "par.ok"
  | "par.okFooter"
  | "par.diffs"
  | "par.cols"
  | "par.more"
  | "par.footer"
  | "par.usage"
  // FinOps
  | "fin.err.duckdb"
  | "fin.err.unavailable"
  | "fin.noData"
  | "fin.head"
  | "fin.head7d"
  | "fin.hint.bq"
  | "fin.hint.oracle"
  | "fin.hint.other"
  | "fin.footer"
  // Confiança (motor SQL + PII)
  | "conf.alta"
  | "conf.media"
  | "conf.baixa"
  // Anti-padrões SQL (mensagens dos achados)
  | "ap.line"
  | "ap.deleteSemWhere"
  | "ap.updateSemWhere"
  | "ap.destrutivo"
  | "ap.selectStarDbt"
  | "ap.selectStar"
  | "ap.selectStarSub"
  | "ap.joinImplicito"
  | "ap.produtoCartesiano"
  | "ap.crossJoin"
  | "ap.notIn"
  | "ap.unionSemAll"
  | "ap.orderBySub"
  | "ap.likeCuringa"
  | "ap.inListaGrande"
  | "ap.funcaoEmFiltro"
  | "ap.cteNaoUsada"
  | "ap.janelaSemPartition"
  | "ap.insertSemColunas"
  | "ap.limitDbt"
  // Cartão do /impacto (dbt) + lineage
  | "dbt.impact.head"
  | "dbt.impact.local"
  | "dbt.impact.upstream"
  | "dbt.impact.downDirect"
  | "dbt.impact.downTransitive"
  | "dbt.impact.tests"
  | "dbt.impact.exposures"
  | "dbt.impact.upstreamRow"
  | "dbt.impact.warning"
  | "dbt.impact.freshness"
  | "dbt.impact.when"
  | "lin.head"
  | "lin.cols"
  | "lin.more"
  | "lin.star"
  | "lin.direct"
  | "lin.expression"
  // Arquitetura (regra de camadas)
  | "arch.rule.hexagonal"
  | "arch.rule.clean"
  | "arch.rule.layered"
  | "arch.rule.mvc"
  | "gate.archViolation"
  // Auditoria PII
  | "pii.head"
  | "pii.noSchema"
  | "pii.clean"
  | "pii.found"
  | "pii.cols"
  | "pii.more"
  | "pii.next"
  | "pii.footer"
  | "pii.cat.doc"
  | "pii.cat.nome"
  | "pii.cat.email"
  | "pii.cat.telefone"
  | "pii.cat.endereco"
  | "pii.cat.nascimento"
  | "pii.cat.financeiro"
  | "pii.cat.cartao"
  | "pii.cat.credencial"
  | "pii.cat.sensivel"
  | "pii.cat.geo"
  // Secrets
  | "secrets.weakKeyring";

export const HOST_MESSAGES: Record<Locale, Partial<Record<HostMessageKey, string>>> = {
  "pt-BR": {
    "dialog.skillsReindexed": "FORGE: skills reindexadas.",
    "dialog.signedOut": "FORGE: licença e credenciais removidas.",
    "notice.openFolder.rules": "Abra uma pasta no VS Code para salvar regras do projeto.",
    "notice.rule.exists": "Essa regra já está no perfil do projeto.",
    "notice.charterSaved": "Charter salvo em .forge/project.md (injetado em todo prompt).",
    "notice.noBlueprint": "Nenhum blueprint aprovado. Planeje o projeto primeiro.",
    "preset.note.hubgpu": "O proxy autentica por outra via (rede / SSO).",
    "preset.note.openai": "Requer API key da OpenAI (egress externo deve estar liberado).",
    "preset.note.anthropic": "Formato Messages nativo. Requer API key Anthropic.",
    "rag.test.disabled": "RAG desabilitado.",
    "rag.test.lexical": "Sem endpoint de embeddings — recuperação lexical (BM25).",
    "rag.test.ok": "Embeddings OK ({dims} dims).",
    "search.label": "Buscar (rede interna)",
    "notice.openFolder.profile": "Abra uma pasta no VSCode para ter um perfil do projeto.",
    "notice.openFolder.role": "Abra uma pasta no VSCode para definir o papel do projeto.",
    "notice.openFolder.charter": "Abra uma pasta no VSCode para salvar o charter.",
    "notice.openFolder.attach": "Abra uma pasta no VSCode para anexar arquivos do workspace.",
    "notice.openFolder.apply": "Abra uma pasta no VSCode para aplicar mudanças.",
    "notice.openFolder.codeBlock": "Abra uma pasta no VSCode para salvar um trecho como arquivo.",
    "notice.openFolder.tests": "Abra uma pasta no VSCode para rodar os testes.",
    "notice.openFolder.env": "Abra uma pasta no VSCode para preparar o ambiente.",
    "notice.rule.added": "Regra adicionada ao perfil do projeto ({path}).",
    "notice.charter.fillReqs": "Preencha os Requisitos (funcionais/não funcionais) no Charter antes de gerar os testes de aceitação.",
    "charter.err.truncated": "O modelo atingiu o limite de tokens antes de redigir a seção. Tente de novo; se persistir, aumente forge.provider.maxOutput.",
    "charter.err.empty": "O modelo não retornou conteúdo para a seção. Tente de novo (detalhes no painel Output → FORGE).",
    "charter.err.license": "Licença requerida para redigir com o modelo.",
    "charter.err.provider": "Configure um provedor antes de redigir (Configurar provedor).",
    "charter.warn.error": "A redação foi interrompida por um erro antes de terminar ({error}) — o final pode estar faltando. Revise antes de salvar (ou redija de novo).",
    "charter.warn.truncatedAfterContinue": "A seção seguiu cortada mesmo após o FORGE continuar a redação automaticamente — o final pode estar faltando. Revise antes de salvar (ou redija de novo).",
    "charter.warn.truncated": "A seção foi truncada no limite de tokens — o final pode estar faltando. Revise antes de salvar (ou redija de novo).",
    "bp.err.license": "Licença requerida para planejar o projeto.",
    "bp.err.email": "Informe seu e-mail na configuração inicial antes de planejar.",
    "bp.err.provider": "Configure um provedor antes de planejar.",
    "bp.err.genLicense": "Licença requerida para gerar o projeto.",
    "bp.err.genEmail": "Informe seu e-mail na configuração inicial antes de gerar.",
    "bp.err.truncated": "O modelo atingiu o limite de tokens de saída antes de terminar o plano — aumente forge.provider.maxOutput ou reduza o escopo da descrição.",
    "bp.err.noArray": "O modelo respondeu, mas sem um array JSON de plano válido, mesmo após pedir a conversão.",
    "bp.err.empty": "O modelo não retornou conteúdo (a resposta veio vazia nas duas tentativas).",
    "bp.err.detail": "{detail} Detalhes técnicos no painel Output → FORGE. Tente de novo — ou ajuste o modelo/esforço no rodapé.{head}",
    "bp.err.head": " Início da resposta: \"{head}\"",
    "bp.err.noneGenerated": "Não consegui gerar nenhum arquivo (falha do provedor ou limite de tokens). Ajuste e clique em \"Aprovar e gerar\" para tentar de novo.",
    "bp.step.analyze": "Analisando os requisitos e desenhando a arquitetura…",
    "bp.step.reasoning": "Raciocinando sobre a arquitetura…",
    "bp.step.order": "Ordenando os arquivos por dependência…",
    "bp.step.convert": "A resposta veio sem o plano completo — pedindo a conversão…",
    "bp.step.converting": "Convertendo o plano…",
    "bp.step.receiving": "Recebendo o plano do modelo…",
    "bp.warn.truncated": "A resposta truncou no limite de tokens e recuperei um plano parcial — arquivos do fim podem faltar. Revise a lista antes de aprovar (ou tente de novo).",
    "bp.warn.salvaged": "A resposta veio cortada no meio do plano (sem sinal de truncamento) e recuperei os arquivos completos — os do fim podem faltar. Revise a lista antes de aprovar (ou tente de novo).",
    "notice.project.autoRepair": "Auto-reparo do projeto: {count} arquivo(s) com erro de contrato — regenerando (rodada {round}/{max})…",
    "notice.project.architecture": "Arquitetura: {count} arquivo(s) violam a regra de camadas (a camada interna importa a externa) — corrija a DIREÇÃO do import (inverta a dependência / use uma port). Esses arquivos estão bloqueados no Aplicar.",
    "notice.project.dod": "Definição de pronto: o projeto está incompleto ({count} requisito(s) faltando) — Aplicar bloqueado até fechar. {errors}",
    "notice.project.security": "Segurança: {count} arquivo(s) com achado de ALTO risco do bandit (severidade+confiança altas) — Aplicar bloqueado. Corrija a vulnerabilidade apontada no cartão.",
    "notice.project.incomplete": "Projeto: {done}/{total} arquivos gerados. Os que faltaram estão em vermelho — clique em \"Aprovar e gerar\" de novo para completar.",
    "notice.project.scaffold": "Scaffold determinístico: {count} arquivo(s) NOVOS materializados de skills ativadas — {files}. Herdaram o gate.",
    "notice.project.initCreated": "Estrutura de pacotes: criei {count} arquivo(s) __init__.py ausente(s) para os imports do projeto resolverem.",
    "notice.regate.nothing": "Nada para re-verificar — gere o projeto primeiro.",
    "notice.regate.running": "Re-rodando a verificação sobre as propostas existentes…",
    "notice.deps.reconciled": "Reconciliação de dependências: adicionei ao {path} {count} pacote(s) usado(s) no código mas não declarado(s): {packages}. Revise antes de aplicar.",
    "notice.smoke.noVenv": "Smoke test dos testes gerados pulado: sem venv do workspace. Rode Preparar ambiente para validar que o projeto de fato roda.",
    "notice.applyAll": "Aplicar tudo: {parts}.",
    "notice.applyAll.applied": "{count} aplicado(s)",
    "notice.applyAll.blocked": "{count} bloqueado(s) pelo quality gate",
    "notice.applyAll.blockedHint": " — use \"Forçar bloqueados\" se revisou",
    "notice.applyAll.partial": "{count} parcial(is) pulado(s) — revise e aplique pelo cartão",
    "notice.contractPolicy.applyAll": "Bloqueado por política do admin (forge.gate.blockUnverifiedContract): o contrato cross-file precisa ser VERIFICADO antes de aplicar tudo. Rode \"Preparar ambiente\" (cria o venv) e depois \"Re-verificar contrato\" (o gate instala o mypy no venv e verifica as MESMAS propostas, sem regenerar).",
    "notice.contractPolicy.applyFile": "Bloqueado por política do admin (forge.gate.blockUnverifiedContract): o contrato cross-file precisa ser VERIFICADO antes de aplicar arquivos do projeto. Rode \"Preparar ambiente\" e depois \"Re-verificar contrato\".",
    "notice.apply.forced": "Aplicado por cima do gate reprovado (sob sua revisão): {path} — registrado no diagnóstico.",
    "notice.apply.outsideWorkspace": "Caminho fora do workspace recusado: {path}",
    "notice.invalidPath": "Caminho inválido ou fora do workspace: {path}",
    "notice.proposal.expired": "Proposta não encontrada (expirada).",
    "notice.proposal.copied": "Conteúdo de {path} copiado.",
    "notice.codeBlock.needPath": "Informe um caminho de arquivo para salvar o trecho.",
    "notice.codeBlock.needReply": "Gere uma resposta antes de salvar um trecho como arquivo.",
    "notice.cell.openFailed": "Não foi possível abrir o notebook: {error}",
    "notice.cell.applyFailed": "Falha ao aplicar a célula no notebook.",
    "notice.cell.applyFirst": "Aplique a célula antes de executá-la.",
    "notice.cell.runFailed": "Falha ao executar a célula (kernel disponível?): {error}",
    "notice.license.noPubkey": "Chave pública de licença não embutida. Rode `npm run keygen` (admin) antes de validar licenças.",
    "notice.license.refused": "Licença recusada: {error}",
    "notice.license.activated": "Licença ativada.",
    "notice.license.required": "Licença requerida. Ative a licença para gerar código.",
    "notice.email.invalid": "E-mail inválido. Informe um e-mail corporativo válido.",
    "notice.email.saved": "E-mail registrado para a observabilidade.",
    "notice.email.required": "Informe seu e-mail na configuração inicial antes de gerar código.",
    "notice.provider.configured": "Provedor configurado.",
    "notice.provider.none": "Nenhum provedor configurado.",
    "notice.provider.beforeMaxOutput": "Configure um provedor antes de definir o máximo de tokens de saída.",
    "notice.context.cleared": "Contexto limpo: histórico e anexos zerados.",
    "notice.context.provider": "Configure um provedor para ver o orçamento de contexto.",
    "notice.webBlocked": "Por política, o FORGE não navega na internet pública (soberania de dados). O admin pode habilitar uma fonte interna (MCP) em forge.search.server.",
    "notice.langfuseSaved": "Secret do Langfuse salva. Habilite forge.observability.langfuse.enabled, defina baseUrl/publicKey e adicione o host do Langfuse em forge.egress.allowedHosts.",
    "notice.summarize.empty": "Nada para resumir — o histórico está vazio.",
    "notice.summarize.license": "Licença requerida para resumir.",
    "notice.summarize.provider": "Configure um provedor antes de resumir.",
    "notice.summarize.failed": "Não consegui resumir: {error}",
    "notice.summarize.emptyResult": "O modelo não retornou o resumo — o histórico foi mantido intacto. Tente de novo.",
    "notice.summarize.drift": "O histórico mudou durante o resumo — descartei o resumo para não perder nada. Rode /resumir de novo.",
    "notice.attach.unreadable": "Não foi possível ler {path} (binário?).",
    "notice.attach.binary": "Não foi possível ler o arquivo (provavelmente binário). Suportado: texto.",
    "notice.attach.selectEditor": "Selecione um trecho no editor para anexar.",
    "notice.attach.noTerminal": "Nenhum terminal ativo. Abra um terminal e selecione um trecho para anexar.",
    "notice.attach.selectTerminal": "Selecione um trecho no terminal para anexar e tente novamente.",
    "notice.ocr.badImage": "Não reconheci a imagem colada. Cole um print (PNG/JPG) ou o texto do log.",
    "notice.ocr.tooBig": "Imagem inválida ou grande demais para OCR (máx. 8 MB).",
    "notice.ocr.inFlight": "Já estou extraindo o texto de um print — aguarde terminar.",
    "notice.ocr.running": "Extraindo texto do print (OCR)…",
    "notice.ocr.noText": "Não encontrei texto legível no print. Se for um erro/log, cole o texto direto.",
    "notice.ocr.prepFailed": "Não consegui preparar o print para OCR: {error}",
    "notice.ocr.needTesseract": "OCR requer o 'tesseract' acessível (no PATH, ou configure o caminho em forge.ocr.tesseractPath — pode ser um tesseract portable, sem admin). Enquanto isso, cole o texto do log direto no chat.",
    "notice.ocr.failed": "Falha no OCR do print: {error}{hint}",
    "notice.ocr.tessdataHint": " Verifique forge.ocr.tessdataPath (a pasta precisa conter os .traineddata dos idiomas).",
    "notice.search.unconfigured": "Busca interna não configurada (defina forge.search.server).",
    "notice.search.running": "Buscando \"{query}\" em {server}…",
    "notice.search.failed": "Busca falhou: {error}",
    "notice.tests.disabled": "Testes desabilitados (forge.test.enabled = false).",
    "notice.run.busy": "Há uma execução em andamento (ex.: preparar ambiente). Aguarde ou cancele.",
    "notice.tests.runDisabled": "pytest ausente e a execução de comandos está desabilitada (forge.run.enabled) — instale manualmente no venv.",
    "notice.tests.cancelled": "Testes cancelados: pytest ausente no ambiente.",
    "notice.tests.busyLater": "Há uma execução em andamento — rode os testes de novo quando ela terminar.",
    "notice.env.venvFailed": "Não consegui criar o venv — veja o cartão 'ambiente'.",
    "notice.tests.installNotStarted": "A instalação do pytest não iniciou (há uma execução em andamento ou a execução está desabilitada). Tente de novo.",
    "notice.tests.installFailed": "A instalação do pytest falhou — veja o cartão de execução.",
    "notice.env.reqIncremented": "requirements.txt incrementado: {packages}.",
    "notice.env.pyprojectNoBuild": "pyproject.toml sem [project]/[build-system]: crio o venv e atualizo o pip (adicione requirements.txt ou torne o pacote instalável para instalar dependências).",
    "notice.env.reqGenerated": "requirements.txt gerado com {count} pacote(s) detectado(s) no código: {packages}. Revise à vontade.",
    "notice.env.noDeps": "Nenhuma dependência de terceiros detectada — crio o venv (.venv) e atualizo o pip.",
    "run.label.env": "ambiente",
    "run.label.pytestInstall": "pytest · instalação",
    "run.label.gateMypy": "gate · mypy (coerência)",
    "run.label.gateBandit": "gate · bandit (segurança)",
    "run.label.cell": "célula [{index}]",
    "run.label.tests": "testes",
    "run.cell.noOutput": "(sem saída capturada — veja a célula no notebook)",
    "notice.gate.blockedApply": "Quality gate reprovado: corrija os problemas apontados pelos validadores — ou use \"Aplicar assim mesmo, revisei\" para aplicar sob sua responsabilidade.",
    "sql.writeCancelled": "Execução cancelada pelo dev (escrita não confirmada).",
    "notice.diag.exportFailed": "Não consegui exportar o diagnóstico (veja Mostrar logs).",
    "notice.review.license": "Licença requerida para revisar.",
    "notice.review.email": "Informe seu e-mail na configuração inicial antes de revisar.",
    "notice.review.none": "Nenhuma alteração para revisar.",
    "rag.capped": "RAG: teto de {max} trechos atingido — parte do codebase NÃO foi indexada (a recuperação de contexto fica incompleta). Restrinja forge.rag.include ou aumente o filtro de exclusão.",
    "gate.py.advisory": "Gate consultivo: compileall/mypy indisponíveis no ambiente — nada foi bloqueado (o projeto pode não rodar).",
    "gate.py.failed": "Gate reprovou: {count} arquivo(s) não compilam/importam. O \"Aplicar\" deles está bloqueado até corrigir.",
    "gate.py.unattributed": "Gate rodou mas não consegui localizar a falha por arquivo (veja os detalhes) — nada foi bloqueado.",
    "gate.py.ok": "Gate verde: o conjunto compila e importa (compileall + mypy sem erros de contrato).",
    "gate.py.partial": "Gate parcial: compilou sem erro de sintaxe (compileall), mas o mypy não rodou — o drift de contrato cross-file NÃO foi verificado.",
    "gate.go.advisory": "Gate consultivo: go/gofmt indisponíveis no ambiente — nada foi bloqueado (o projeto pode não compilar).",
    "gate.go.failed": "Gate reprovou: {count} arquivo(s) com erro de sintaxe (gofmt). O \"Aplicar\" deles está bloqueado até corrigir.",
    "gate.go.ok": "Gate Go: sem erro de sintaxe (gofmt); a compilação completa (go build) rodou como advisory — sem as dependências não é veredito.",
    "gate.java": "Gate Java: arquitetura (regra de camadas) verificada — a compilação (javac) não roda neste ambiente e fica de fora; nada bloqueado por camadas.",
    "gate.dodIncomplete": "Definição de pronto: o projeto está incompleto ({count} requisito(s) faltando) — Aplicar bloqueado até fechar.",
    "gate.alsoBlocked": " Também {count} arquivo(s) com erro ({parts}).",
    "gate.blocked": "Gate reprovou: {count} arquivo(s) bloqueados{parts}. Corrija antes de aplicar.",
    "gate.securitySuffix": " · segurança: {count} aviso(s) do bandit (não bloqueiam).",
    "gate.part.compile": "{count} de compilação/contrato",
    "gate.part.syntaxGo": "{count} de sintaxe (gofmt)",
    "gate.part.arch": "{count} de arquitetura (regra de camadas)",
    "gate.part.security": "{count} de segurança (bandit ALTO)",
    "gate.tscSuffix": " · tsc: {count} aviso(s) de tipo (advisory — instale as deps e rode o tsc para o veredito completo)",
    "gate.goSuffix": " · go build: {count} aviso(s) (advisory — rode go build ./... com as dependências para o veredito completo)",
    "gate.moreSecurity": "… e mais {count} aviso(s) — veja o log de diagnóstico.",
    "gate.couldntRun.policy": "Não consegui rodar o gate de compilação — e a política do admin exige contrato verificado. Prepare o ambiente e re-verifique.",
    "gate.couldntRun": "Não consegui rodar o gate de compilação (ambiente) — nada foi bloqueado.",
    "smoke.timeout": "Smoke test dos testes gerados: tempo esgotado (inconclusivo — não bloqueia).",
    "smoke.noPython": "Smoke test pulado: Python indisponível para rodar a suíte gerada.",
    "smoke.passed": "Smoke test: {count} teste(s) gerado(s) PASSARAM no venv do workspace — o projeto de fato roda, não só compila.",
    "smoke.passedAll": "Smoke test: os teste(s) gerado(s) PASSARAM no venv do workspace — o projeto de fato roda, não só compila.",
    "smoke.failed": "Smoke test: {count} teste(s) gerado(s) FALHARAM no venv do workspace — revise antes de aplicar. (Advisory: o gate não bloqueia o Aplicar por isto.)",
    "smoke.none": "Smoke test: nenhum teste foi coletado na suíte gerada.",
    "smoke.noPytest": "Smoke test pulado: pytest não está instalado no venv. Rode Preparar ambiente para validar que os testes gerados passam.",
    "smoke.importFailed": "Smoke test pulado: não consegui importar todos os módulos (dependências de terceiros ausentes, ou o projeto precisa de instalação editável). Rode Preparar ambiente — os testes gerados ainda não foram executados.",
    "smoke.notPassed": "Smoke test: a suíte gerada não passou (veja os logs do FORGE em Mostrar logs). Revise antes de aplicar. (Advisory: não bloqueia o Aplicar.)",
    "dialog.ragReindexed": "FORGE RAG: {files} arquivos, {chunks} trechos (modo {mode}).",
    "dialog.role.placeholder": "Seu papel no projeto — ajusta o estilo e os defaults do FORGE",
    "role.cientista": "Cientista de dados",
    "role.engDados": "Engenheiro de dados",
    "role.engMl": "Engenheiro de ML",
    "role.engIa": "Engenheiro de IA",
    "role.engSoftware": "Engenheiro de software",
    "dialog.maxOutput.title": "Máximo de tokens de saída (por sessão)",
    "dialog.maxOutput.placeholder": "Escolha o teto de saída — valores altos são rebaixados ao que o gateway serve",
    "dialog.maxOutput.auto": "auto (catálogo do modelo)",
    "dialog.maxOutput.tokens": "{label} tokens",
    "dialog.maxOutput.current": "atual",
    "dialog.maxOutput.autoDesc": "usa o teto do catálogo / config do admin",
    "dialog.maxOutput.loweredDesc": "rebaixado à janela servida se necessário",
    "dialog.langfuse.prompt": "Langfuse secret key (sk-lf-…) — guardada no SecretStorage, nunca em settings",
    "dialog.search.prompt": "Buscar na fonte interna ({server})",
    "dialog.search.placeholder": "termos da busca…",
    "dialog.attach.placeholder": "Anexar arquivo do workspace ao contexto",
    "dialog.run.openFile": "FORGE: abra um arquivo do workspace para executar.",
    "dialog.pytest.installVenv": "O pytest não está instalado no ambiente (.venv). Instalar agora e rodar os testes?",
    "dialog.pytest.createVenv": "Não há venv neste projeto. Criar o .venv com as dependências do código, instalar o pytest e rodar os testes?",
    "dialog.pytest.installBtn": "Instalar e rodar",
    "dialog.cancel": "Cancelar",
    "dialog.deps.detected": "Detectei no código pacote(s) ausente(s) do requirements.txt: {packages}. Adicionar?",
    "dialog.deps.addBtn": "Adicionar e instalar",
    "dialog.deps.onlyListedBtn": "Instalar só o que está listado",
    "dialog.diag.exported": "FORGE: diagnóstico exportado ({count} eventos, redigido). Anexe este arquivo ao relato de bug.",
    "card.git.openFolder": "### Git\n\nAbra uma pasta no VSCode para usar os comandos de git.",
    "card.git.untrusted": "### Git\n\n🔒 Este workspace **não é confiável** — os comandos de git ficam desabilitados (o git pode executar scripts definidos pelo repositório). Confie na pasta (canto inferior esquerdo do VSCode) para habilitar.",
    "card.git.nothingToCommit": "### Git · commit\n\n_Nada a commitar: nenhum arquivo **rastreado** foi modificado. (Arquivos novos exigem `git add` antes — use o painel Git do VSCode.)_",
    "card.git.cancelled": "### Git · commit\n\n_Commit cancelado._",
    "card.git.failed": "### Git\n\nFalha ao executar: {error}",
    "card.conn.header": "### Conexões",
    "card.conn.none": "### Conexões\n\nNenhuma conexão configurada. O admin (ou você) declara em `forge.warehouse.connections` — ex.: Oracle 19c/26ai/Exadata/ADW (`kind: oracle`, SQLcl/sqlplus), PostgreSQL (`psql`), BigQuery (`bq`), DuckDB local, S3/OCI Object Storage. Senhas ficam no SecretStorage (pedidas no primeiro uso).",
    "card.conn.cols": "| id | tipo | destino | acesso | teste |",
    "card.conn.rw": "leitura+escrita",
    "card.conn.ro": "somente leitura",
    "card.conn.footer": "_Escrita exige `readonly:false` NA CONEXÃO + confirmação por execução; DROP/TRUNCATE nunca executam._",
    "card.sql.openFile": "### Executar SQL\n\nAbra um arquivo `.sql` no editor (a seleção, se houver, é o que executa) e rode `/executar-sql [conexão]`.",
    "card.sql.connNotExists": "### Executar SQL\n\nConexão `{id}` não existe — veja `/conexoes`.",
    "card.sql.connUnconfigured": "### Executar SQL\n\nConexão não configurada — veja `/conexoes`.",
    "card.sql.frame": "### Executar SQL · `{id}`\n\n{message}",
    "card.sql.resultTitle": "Resultado · `{id}`",
    "card.cost.none": "### Custo\n\nNenhuma conexão configurada — veja `/conexoes`.",
    "card.cost.previewTitle": "Custo da consulta (prévia, sem executar) · `{id}`",
    "card.cost.previewFrame": "### Custo (prévia) · `{id}`\n\n{message}",
    "card.cost.frame": "### Custo · `{id}`\n\n{message}",
    "card.schema.none": "### Schema do warehouse\n\nNenhuma conexão configurada — veja `/conexoes`.",
    "card.schema.frame": "### Schema do warehouse · `{id}`\n\n{message}",
    "card.schema.invFailed": "Falha no inventário:\n```\n{output}\n```",
    "card.schema.ok": "### Schema do warehouse · `{id}`\n\n✅ **{tables} tabelas** indexadas ({columns} colunas). O schema real agora entra no prompt e no gate semântico — tabela/coluna fantasma vira achado.\n\n_⚠ O snapshot da amostra foi capado em {rowCap} linhas? Não — inventário usa o cap de 50k colunas do SQL. Rode de novo após DDLs relevantes._",
    "card.parity.frame": "### Paridade de dados\n\n{message}",
    "card.parity.connNotExists": "Conexão {id} não existe.",
    "card.parity.profileFailed": "Perfil de `{table}` falhou:\n```\n{output}\n```",
    "card.data.unknown": "Comando de dados desconhecido: `{cmd}`.",
    "card.data.failed": "### /{cmd}\n\nFalhou: {error}",
    "card.impact.frame": "### Raio de explosão\n\n{message}",
    "card.impact.noManifest": "### Raio de explosão\n\nSem grounding dbt: não encontrei `target/manifest.json` no workspace. Rode `dbt parse` (ou `dbt compile`) no projeto dbt e tente de novo — o FORGE lê o lineage real do manifest.",
    "card.impact.notFound": "O modelo `{model}` não existe no manifest do dbt.",
    "card.impact.notFoundSug": "O modelo `{model}` não existe no manifest do dbt — você quis dizer `{name}`?",
    "card.impact.openModel": "Abra o arquivo de um modelo dbt no editor (ou use `/impacto nome_do_modelo`).",
    "git.msg.required": "Informe a mensagem: `/git-commit \"sua mensagem\"`.",
    "git.msg.tooLong": "Mensagem muito longa (máx. 2000 caracteres).",
    "git.st.modified": "modificado",
    "git.st.added": "adicionado",
    "git.st.deleted": "removido",
    "git.st.renamed": "renomeado",
    "git.st.copied": "copiado",
    "git.st.conflict": "conflito",
    "git.st.new": "novo",
    "git.st.untracked": "novo (não rastreado)",
    "git.noBranch": "(sem branch)",
    "git.ahead": "**{n}** à frente",
    "git.behind": "**{n}** atrás",
    "git.clean": "_Working tree limpo — nada a commitar._",
    "git.cols": "| arquivo | estado |",
    "git.more": "| … | e mais {n} |",
    "git.commitHint": "_{n} arquivo(s) rastreado(s) entrariam num `/git-commit` (novos exigem `git add` antes)._",
    "git.diff.empty": "### Git · diff\n\n_Sem alterações vs. `HEAD` (working tree limpo)._",
    "git.diff.truncated": "… (diff truncado)",
    "git.log.empty": "### Git · log\n\n_Sem commits._",
    "git.log.cols": "| commit | autor | quando | assunto |",
    "git.commit.ok": "✅ Commit criado.",
    "git.commit.fail": "❌ Falhou.",
    "git.unavailable": "git indisponível ou esta pasta não é um repositório.",
    "wh.err.oracleConnect": "Conexão \"{id}\": connect deve ser \"usuario@alias_tns\" ou \"usuario@//host:porta/servico\".",
    "wh.err.psqlConnect": "Conexão \"{id}\": connect deve ser a URI/DSN do psql.",
    "wh.err.objectStorage": "Conexão \"{id}\" é de OBJECT STORAGE — não executa SQL. Use /conexoes para listar o conteúdo, ou uma conexão duckdb para consultar arquivos.",
    "wh.err.unknownKind": "Tipo de conexão desconhecido: {kind}",
    "wh.err.costSingle": "Prévia de custo aceita só UM statement — selecione apenas o SELECT que quer estimar.",
    "wh.err.costSingleShort": "Prévia de custo aceita só UM statement.",
    "wh.err.costUnavailable": "Prévia de custo não disponível para este tipo de conexão.",
    "wh.result.noOutput": "(sem saída)",
    "wh.result.capped": " · ⚠ amostra capada em {n} linhas",
    "wh.result.masked": "_Valores sensíveis são mascarados localmente antes de qualquer exibição (LGPD)._",
    "wh.pwd.title": "Senha da conexão \"{id}\" ({kind})",
    "wh.pwd.prompt": "Guardada no SecretStorage do VSCode (keyring do SO) — nunca em settings ou em disco.",
    "wh.err.unsafeField": "Conexão \"{id}\": o campo `{field}` contém caracteres não permitidos (metacaractere de shell) — corrija forge.warehouse.connections.",
    "wh.err.unsafeSchema": "Conexão \"{id}\": um item de `schemas` contém caracteres não permitidos.",
    "wh.err.connNotExists": "Conexão \"{id}\" não existe — veja /conexoes.",
    "wh.err.noneConfigured": "Nenhuma conexão configurada (forge.warehouse.connections).",
    "wh.err.noneConfiguredShort": "Nenhuma conexão configurada.",
    "wh.err.costReadonly": "⛔ Prévia de custo é somente leitura — a consulta contém escrita ou statement não confirmado ({reason}). Rode só o SELECT que quer estimar.",
    "wh.err.toolMissing": "A ferramenta `{tool}` não está no PATH. Instale-a ({hint}) — o FORGE usa o CLI que você já usa, sem driver embutido.",
    "wh.err.spawnFailed": "Falha ao iniciar {tool}: {error}",
    "wh.hint.sqlcl": "SQLcl — baixe em oracle.com/sqlcl; conecta 19c, 26ai, Exadata e ADW (wallet)",
    "wh.hint.duckdb": "duckdb.org — binário único",
    "wh.hint.default": "instale e garanta no PATH",
    "wh.err.schemaBigQuery": "BigQuery precisa de `schemas` na conexão (datasets a inventariar) — INFORMATION_SCHEMA é por dataset.",
    "wh.err.schemaUnavailable": "Snapshot de schema não disponível para este tipo de conexão.",
    "val.label.sqlSecurity": "SQL · segurança",
    "val.label.sqlAntipatterns": "SQL · anti-padrões",
    "val.label.sqlSchema": "SQL · schema (dbt)",
    "par.absent": "(ausente)",
    "par.head": "### Paridade de dados · `{left}` × `{right}`",
    "par.ok": "✅ **Paridade OK** — {n} métricas conferem (count, não-nulos e distintos por coluna).",
    "par.okFooter": "_Comparação por AGREGADOS: nenhuma linha saiu dos bancos (compliance-safe)._",
    "par.diffs": "❌ **{count, plural, one{# divergência} other{# divergências}}** em {total} métricas:",
    "par.cols": "| métrica | coluna | {left} | {right} |",
    "par.more": "_… +{n} divergências._",
    "par.footer": "_Comparação por AGREGADOS: nenhuma linha saiu dos bancos (compliance-safe). Divergência em `count` = volume; em `distintos` = duplicatas/dedup; em `nao_nulos` = perda de dados na carga._",
    "par.usage": "Uso: `/paridade tabela_a tabela_b` — opcionalmente `conexao:tabela` em cada lado (paridade entre warehouses).",
    "fin.err.duckdb": "DuckDB é local — não há histórico de custo de warehouse para analisar.",
    "fin.err.unavailable": "Relatório de custo não disponível para este tipo de conexão.",
    "fin.noData": "Nenhum dado retornado. Causas comuns: falta de privilégio no dicionário (Oracle v$sql), extensão `pg_stat_statements` ausente (Postgres), ou region errada no `schemas` da conexão (BigQuery).",
    "fin.head": "### Custo · `{id}`",
    "fin.head7d": "### Custo (últimos 7 dias) · `{id}`",
    "fin.hint.bq": "1 TB processado ≈ US$ 6,25 (on-demand). Ataque primeiro os maiores `tb_processados`: SELECT * e falta de filtro de partição são as causas nº 1.",
    "fin.hint.oracle": "Alto `gets_por_exec` = consulta cara por execução (índice/plano); alto `execucoes` × tempo médio = candidato a cache/materialização.",
    "fin.hint.other": "Alto `tempo_total_s` com muitas `execucoes` = otimize a consulta; poucas execuções muito lentas = revise plano/índices.",
    "fin.footer": "_Fonte determinística: metadados do próprio warehouse — nenhum dado de negócio saiu do banco._",
    "conf.alta": "alta",
    "conf.media": "média",
    "conf.baixa": "baixa",
    "ap.line": "{icon} linha {line} [{rule}] (confiança {conf}): {message}",
    "ap.deleteSemWhere": "DELETE sem WHERE apaga a tabela inteira — se é intencional, use TRUNCATE explícito e revise.",
    "ap.updateSemWhere": "UPDATE sem WHERE reescreve TODAS as linhas da tabela.",
    "ap.destrutivo": "{kind} é destrutivo e irreversível — não deveria nascer de código gerado sem revisão explícita.",
    "ap.selectStarDbt": "SELECT * no modelo propaga qualquer mudança do upstream (schema drift silencioso) — liste as colunas.",
    "ap.selectStar": "SELECT * traz colunas desnecessárias (custo e acoplamento) — liste as colunas.",
    "ap.selectStarSub": "SELECT * em subquery/CTE arrasta colunas que ninguém pediu — liste as colunas.",
    "ap.joinImplicito": "Join implícito (FROM a, b + WHERE) — prefira JOIN … ON explícito: a condição esquecida vira produto cartesiano.",
    "ap.produtoCartesiano": "FROM com múltiplas tabelas SEM WHERE = produto cartesiano (N×M linhas).",
    "ap.crossJoin": "CROSS JOIN multiplica linhas (N×M) — confirme que é intencional (ex.: spine de datas).",
    "ap.notIn": "NOT IN com subquery: UM NULL no resultado da subquery e a query inteira retorna zero linhas — use NOT EXISTS.",
    "ap.unionSemAll": "UNION (sem ALL) deduplica com sort implícito — se não há duplicatas possíveis, UNION ALL é mais barato.",
    "ap.orderBySub": "ORDER BY em subquery sem LIMIT não garante ordem no resultado externo — só custa sort.",
    "ap.likeCuringa": "LIKE '%…' com curinga inicial impede índice/partition pruning — full scan garantido.",
    "ap.inListaGrande": "IN com ~{count} itens literais — mova para uma tabela temporária/CTE e faça JOIN.",
    "ap.funcaoEmFiltro": "{fn}(coluna) no filtro impede índice/pruning (predicado não-sargável) — aplique a função ao LITERAL ou use faixa equivalente.",
    "ap.cteNaoUsada": "A CTE \"{cte}\" é definida e nunca referenciada — código morto que ainda pode ser executado por alguns engines.",
    "ap.janelaSemPartition": "Window function sem PARTITION BY ordena/processa a tabela INTEIRA numa partição só — confirme a intenção.",
    "ap.insertSemColunas": "INSERT sem lista de colunas quebra silenciosamente quando o schema da tabela muda — declare as colunas.",
    "ap.limitDbt": "LIMIT no modelo dbt vai para PRODUÇÃO e trunca o dataset — se era só para desenvolver, remova antes de aplicar.",
    "dbt.impact.head": "### Raio de explosão · `{name}`",
    "dbt.impact.local": "Nenhum modelo, teste ou exposure depende de `{name}` — mudança de impacto LOCAL.",
    "dbt.impact.upstream": "Upstream direto: {list}",
    "dbt.impact.downDirect": "| Downstream direto | {n} — {list} |",
    "dbt.impact.downTransitive": "| Downstream transitivo | {count, plural, one{# modelo} other{# modelos}} (profundidade {depth}) |",
    "dbt.impact.tests": "| Testes impactados | {n} |",
    "dbt.impact.exposures": "| Exposures | {list} |",
    "dbt.impact.upstreamRow": "| Upstream direto | {list} |",
    "dbt.impact.warning": "Mudança em `{name}` pode quebrar {count, plural, one{# consumidor} other{# consumidores}} — revise os downstream diretos antes de aplicar (`dbt build --select {name}+` valida a cadeia).",
    "dbt.impact.freshness": "_Fonte: target/manifest.json{when} — `dbt parse` ou `dbt compile` atualiza o lineage._",
    "dbt.impact.when": " (gerado em {ts})",
    "lin.head": "**Lineage de coluna** (confiança {conf}):",
    "lin.cols": "| saída | transformação | origem |",
    "lin.more": "_… +{n} colunas._",
    "lin.star": "_⚠ O SELECT final usa `*` — colunas propagadas do upstream não aparecem no mapa._",
    "lin.direct": "direta",
    "lin.expression": "expressao",
    "arch.rule.hexagonal": "o domínio não pode importar adapters/infraestrutura — a dependência aponta para DENTRO (os adapters implementam as ports; o domínio não os conhece)",
    "arch.rule.clean": "as camadas internas (entities/use cases) não conhecem as externas (adapters/frameworks) — a regra da dependência aponta para dentro",
    "arch.rule.layered": "a camada de modelo/entidade não pode importar service/repository/apresentação (cada camada só chama a de baixo)",
    "arch.rule.mvc": "o Model não pode importar View nem Controller (Model rico, sem conhecer a apresentação)",
    "gate.archViolation": "viola a arquitetura {arch}: {rule}. Import(s) proibido(s) da camada externa: {imports}.",
    "pii.head": "### Auditoria PII / LGPD (por nome de coluna)",
    "pii.noSchema": "Sem schema para auditar — rode `dbt parse` (projeto dbt) ou `/schema-db` (warehouse) primeiro.",
    "pii.clean": "✅ Nenhuma coluna com nome típico de dado pessoal em {tables} tabelas. (Heurística por NOME — conteúdo não foi lido.)",
    "pii.found": "⚠ **{count, plural, one{# coluna} other{# colunas}} candidatas a dado pessoal** em {tables} tabelas (heurística por NOME — o conteúdo não foi lido):",
    "pii.cols": "| tabela | coluna | categoria | confiança |",
    "pii.more": "_… +{n} colunas._",
    "pii.next": "Próximos passos: mascaramento no warehouse (Oracle: `DBMS_REDACT`/Data Redaction; BigQuery: policy tags + column-level access; Postgres: views com máscara + GRANT por coluna) e minimização nos marts (não propague documento/contato para camadas de consumo).",
    "pii.footer": "_O FORGE já mascara amostras exibidas no chat; a auditoria orienta a proteção NA ORIGEM._",
    "pii.cat.doc": "documento (CPF/CNPJ/RG)",
    "pii.cat.nome": "nome de pessoa",
    "pii.cat.email": "e-mail",
    "pii.cat.telefone": "telefone",
    "pii.cat.endereco": "endereço",
    "pii.cat.nascimento": "nascimento/idade",
    "pii.cat.financeiro": "financeiro pessoal",
    "pii.cat.cartao": "cartão de pagamento",
    "pii.cat.credencial": "credencial",
    "pii.cat.sensivel": "dado sensível (LGPD art. 5º II)",
    "pii.cat.geo": "geolocalização",
    "secrets.weakKeyring": "FORGE: o armazenamento seguro de credenciais não parece disponível neste sistema (keyring ausente). As credenciais podem não estar protegidas. Configure um keyring (ex.: gnome-keyring/libsecret) antes de usar em produção.",
  },
  en: {
    "dialog.skillsReindexed": "FORGE: skills reindexed.",
    "dialog.signedOut": "FORGE: license and credentials removed.",
    "notice.openFolder.rules": "Open a folder in VS Code to save project rules.",
    "notice.rule.exists": "This rule is already in the project profile.",
    "notice.charterSaved": "Charter saved to .forge/project.md (injected into every prompt).",
    "notice.noBlueprint": "No approved blueprint. Plan the project first.",
    "preset.note.hubgpu": "The proxy authenticates by other means (network / SSO).",
    "preset.note.openai": "Requires an OpenAI API key (external egress must be allowed).",
    "preset.note.anthropic": "Native Messages format. Requires an Anthropic API key.",
    "rag.test.disabled": "RAG disabled.",
    "rag.test.lexical": "No embeddings endpoint — lexical retrieval (BM25).",
    "rag.test.ok": "Embeddings OK ({dims} dims).",
    "search.label": "Search (internal network)",
    "notice.openFolder.profile": "Open a folder in VS Code to have a project profile.",
    "notice.openFolder.role": "Open a folder in VS Code to set the project role.",
    "notice.openFolder.charter": "Open a folder in VS Code to save the charter.",
    "notice.openFolder.attach": "Open a folder in VS Code to attach workspace files.",
    "notice.openFolder.apply": "Open a folder in VS Code to apply changes.",
    "notice.openFolder.codeBlock": "Open a folder in VS Code to save a snippet as a file.",
    "notice.openFolder.tests": "Open a folder in VS Code to run the tests.",
    "notice.openFolder.env": "Open a folder in VS Code to prepare the environment.",
    "notice.rule.added": "Rule added to the project profile ({path}).",
    "notice.charter.fillReqs": "Fill in the Requirements (functional/non-functional) in the Charter before generating the acceptance tests.",
    "charter.err.truncated": "The model hit the token limit before drafting the section. Try again; if it persists, increase forge.provider.maxOutput.",
    "charter.err.empty": "The model returned no content for the section. Try again (details in the Output → FORGE panel).",
    "charter.err.license": "License required to draft with the model.",
    "charter.err.provider": "Configure a provider before drafting (Configure provider).",
    "charter.warn.error": "Drafting was interrupted by an error before finishing ({error}) — the ending may be missing. Review before saving (or draft again).",
    "charter.warn.truncatedAfterContinue": "The section remained cut even after FORGE automatically continued the drafting — the ending may be missing. Review before saving (or draft again).",
    "charter.warn.truncated": "The section was truncated at the token limit — the ending may be missing. Review before saving (or draft again).",
    "bp.err.license": "License required to plan the project.",
    "bp.err.email": "Enter your e-mail in the initial setup before planning.",
    "bp.err.provider": "Configure a provider before planning.",
    "bp.err.genLicense": "License required to generate the project.",
    "bp.err.genEmail": "Enter your e-mail in the initial setup before generating.",
    "bp.err.truncated": "The model hit the output token limit before finishing the plan — increase forge.provider.maxOutput or reduce the scope of the description.",
    "bp.err.noArray": "The model responded, but without a valid JSON plan array, even after asking for the conversion.",
    "bp.err.empty": "The model returned no content (the response came back empty in both attempts).",
    "bp.err.detail": "{detail} Technical details in the Output → FORGE panel. Try again — or adjust the model/effort in the footer.{head}",
    "bp.err.head": " Start of the response: \"{head}\"",
    "bp.err.noneGenerated": "I couldn't generate any file (provider failure or token limit). Adjust and click \"Approve and generate\" to try again.",
    "bp.step.analyze": "Analyzing the requirements and designing the architecture…",
    "bp.step.reasoning": "Reasoning about the architecture…",
    "bp.step.order": "Ordering the files by dependency…",
    "bp.step.convert": "The response came without the complete plan — asking for the conversion…",
    "bp.step.converting": "Converting the plan…",
    "bp.step.receiving": "Receiving the plan from the model…",
    "bp.warn.truncated": "The response truncated at the token limit and I recovered a partial plan — files at the end may be missing. Review the list before approving (or try again).",
    "bp.warn.salvaged": "The response came cut in the middle of the plan (no truncation signal) and I recovered the complete files — the ones at the end may be missing. Review the list before approving (or try again).",
    "notice.project.autoRepair": "Project self-repair: {count} file(s) with contract errors — regenerating (round {round}/{max})…",
    "notice.project.architecture": "Architecture: {count} file(s) violate the layer rule (an inner layer imports an outer one) — fix the DIRECTION of the import (invert the dependency / use a port). Those files are blocked in Apply.",
    "notice.project.dod": "Definition of done: the project is incomplete ({count} requirement(s) missing) — Apply blocked until resolved. {errors}",
    "notice.project.security": "Security: {count} file(s) with a HIGH-risk bandit finding (high severity+confidence) — Apply blocked. Fix the vulnerability shown on the card.",
    "notice.project.incomplete": "Project: {done}/{total} files generated. The missing ones are in red — click \"Approve and generate\" again to complete.",
    "notice.project.scaffold": "Deterministic scaffold: {count} NEW file(s) materialized from enabled skills — {files}. They inherit the gate.",
    "notice.project.initCreated": "Package structure: created {count} missing __init__.py file(s) so the project imports resolve.",
    "notice.regate.nothing": "Nothing to re-verify — generate the project first.",
    "notice.regate.running": "Re-running the verification over the existing proposals…",
    "notice.deps.reconciled": "Dependency reconciliation: added to {path} {count} package(s) used in the code but not declared: {packages}. Review before applying.",
    "notice.smoke.noVenv": "Smoke test of the generated tests skipped: no workspace venv. Run Prepare environment to validate that the project actually runs.",
    "notice.applyAll": "Apply all: {parts}.",
    "notice.applyAll.applied": "{count} applied",
    "notice.applyAll.blocked": "{count} blocked by the quality gate",
    "notice.applyAll.blockedHint": " — use \"Force blocked\" if you reviewed",
    "notice.applyAll.partial": "{count} partial skipped — review and apply from the card",
    "notice.contractPolicy.applyAll": "Blocked by admin policy (forge.gate.blockUnverifiedContract): the cross-file contract must be VERIFIED before applying everything. Run \"Prepare environment\" (creates the venv) and then \"Re-verify contract\" (the gate installs mypy in the venv and verifies the SAME proposals, without regenerating).",
    "notice.contractPolicy.applyFile": "Blocked by admin policy (forge.gate.blockUnverifiedContract): the cross-file contract must be VERIFIED before applying project files. Run \"Prepare environment\" and then \"Re-verify contract\".",
    "notice.apply.forced": "Applied over the failed gate (under your review): {path} — recorded in diagnostics.",
    "notice.apply.outsideWorkspace": "Path outside the workspace refused: {path}",
    "notice.invalidPath": "Invalid path or outside the workspace: {path}",
    "notice.proposal.expired": "Proposal not found (expired).",
    "notice.proposal.copied": "Content of {path} copied.",
    "notice.codeBlock.needPath": "Enter a file path to save the snippet.",
    "notice.codeBlock.needReply": "Generate a response before saving a snippet as a file.",
    "notice.cell.openFailed": "Could not open the notebook: {error}",
    "notice.cell.applyFailed": "Failed to apply the cell to the notebook.",
    "notice.cell.applyFirst": "Apply the cell before running it.",
    "notice.cell.runFailed": "Failed to run the cell (is a kernel available?): {error}",
    "notice.license.noPubkey": "License public key not embedded. Run `npm run keygen` (admin) before validating licenses.",
    "notice.license.refused": "License refused: {error}",
    "notice.license.activated": "License activated.",
    "notice.license.required": "License required. Activate the license to generate code.",
    "notice.email.invalid": "Invalid e-mail. Enter a valid corporate e-mail.",
    "notice.email.saved": "E-mail recorded for observability.",
    "notice.email.required": "Enter your e-mail in the initial setup before generating code.",
    "notice.provider.configured": "Provider configured.",
    "notice.provider.none": "No provider configured.",
    "notice.provider.beforeMaxOutput": "Configure a provider before setting the maximum output tokens.",
    "notice.context.cleared": "Context cleared: history and attachments reset.",
    "notice.context.provider": "Configure a provider to see the context budget.",
    "notice.webBlocked": "By policy, FORGE does not browse the public internet (data sovereignty). The admin can enable an internal source (MCP) in forge.search.server.",
    "notice.langfuseSaved": "Langfuse secret saved. Enable forge.observability.langfuse.enabled, set baseUrl/publicKey and add the Langfuse host to forge.egress.allowedHosts.",
    "notice.summarize.empty": "Nothing to summarize — the history is empty.",
    "notice.summarize.license": "License required to summarize.",
    "notice.summarize.provider": "Configure a provider before summarizing.",
    "notice.summarize.failed": "I couldn't summarize: {error}",
    "notice.summarize.emptyResult": "The model did not return the summary — the history was kept intact. Try again.",
    "notice.summarize.drift": "The history changed during the summary — I discarded the summary so nothing is lost. Run /summarize again.",
    "notice.attach.unreadable": "Could not read {path} (binary?).",
    "notice.attach.binary": "Could not read the file (probably binary). Supported: text.",
    "notice.attach.selectEditor": "Select a snippet in the editor to attach.",
    "notice.attach.noTerminal": "No active terminal. Open a terminal and select a snippet to attach.",
    "notice.attach.selectTerminal": "Select a snippet in the terminal to attach and try again.",
    "notice.ocr.badImage": "I didn't recognize the pasted image. Paste a screenshot (PNG/JPG) or the log text.",
    "notice.ocr.tooBig": "Invalid image or too large for OCR (max. 8 MB).",
    "notice.ocr.inFlight": "I'm already extracting text from a screenshot — wait for it to finish.",
    "notice.ocr.running": "Extracting text from the screenshot (OCR)…",
    "notice.ocr.noText": "I found no readable text in the screenshot. If it's an error/log, paste the text directly.",
    "notice.ocr.prepFailed": "I couldn't prepare the screenshot for OCR: {error}",
    "notice.ocr.needTesseract": "OCR requires 'tesseract' to be accessible (on PATH, or set the path in forge.ocr.tesseractPath — a portable tesseract works, no admin). Meanwhile, paste the log text directly into the chat.",
    "notice.ocr.failed": "Screenshot OCR failed: {error}{hint}",
    "notice.ocr.tessdataHint": " Check forge.ocr.tessdataPath (the folder must contain the language .traineddata files).",
    "notice.search.unconfigured": "Internal search not configured (set forge.search.server).",
    "notice.search.running": "Searching \"{query}\" on {server}…",
    "notice.search.failed": "Search failed: {error}",
    "notice.tests.disabled": "Tests disabled (forge.test.enabled = false).",
    "notice.run.busy": "There is a run in progress (e.g., prepare environment). Wait or cancel.",
    "notice.tests.runDisabled": "pytest missing and command execution is disabled (forge.run.enabled) — install it manually in the venv.",
    "notice.tests.cancelled": "Tests cancelled: pytest missing from the environment.",
    "notice.tests.busyLater": "There is a run in progress — run the tests again when it finishes.",
    "notice.env.venvFailed": "I couldn't create the venv — see the 'environment' card.",
    "notice.tests.installNotStarted": "The pytest installation didn't start (there is a run in progress or execution is disabled). Try again.",
    "notice.tests.installFailed": "The pytest installation failed — see the run card.",
    "notice.env.reqIncremented": "requirements.txt updated: {packages}.",
    "notice.env.pyprojectNoBuild": "pyproject.toml without [project]/[build-system]: I create the venv and update pip (add a requirements.txt or make the package installable to install dependencies).",
    "notice.env.reqGenerated": "requirements.txt generated with {count} package(s) detected in the code: {packages}. Review at will.",
    "notice.env.noDeps": "No third-party dependencies detected — I create the venv (.venv) and update pip.",
    "run.label.env": "environment",
    "run.label.pytestInstall": "pytest · install",
    "run.label.gateMypy": "gate · mypy (coherence)",
    "run.label.gateBandit": "gate · bandit (security)",
    "run.label.cell": "cell [{index}]",
    "run.label.tests": "tests",
    "run.cell.noOutput": "(no output captured — see the cell in the notebook)",
    "notice.gate.blockedApply": "Quality gate failed: fix the issues reported by the validators — or use \"Apply anyway, I reviewed\" to apply under your responsibility.",
    "sql.writeCancelled": "Run cancelled by the dev (write not confirmed).",
    "notice.diag.exportFailed": "I couldn't export the diagnostics (see Show logs).",
    "notice.review.license": "License required to review.",
    "notice.review.email": "Enter your e-mail in the initial setup before reviewing.",
    "notice.review.none": "No changes to review.",
    "rag.capped": "RAG: cap of {max} chunks reached — part of the codebase was NOT indexed (context retrieval is incomplete). Narrow forge.rag.include or extend the exclusion filter.",
    "gate.py.advisory": "Advisory gate: compileall/mypy unavailable in the environment — nothing was blocked (the project may not run).",
    "gate.py.failed": "Gate failed: {count} file(s) don't compile/import. Their \"Apply\" is blocked until fixed.",
    "gate.py.unattributed": "The gate ran but I couldn't attribute the failure to a file (see the details) — nothing was blocked.",
    "gate.py.ok": "Gate green: the set compiles and imports (compileall + mypy with no contract errors).",
    "gate.py.partial": "Partial gate: compiled with no syntax errors (compileall), but mypy didn't run — cross-file contract drift was NOT verified.",
    "gate.go.advisory": "Advisory gate: go/gofmt unavailable in the environment — nothing was blocked (the project may not compile).",
    "gate.go.failed": "Gate failed: {count} file(s) with syntax errors (gofmt). Their \"Apply\" is blocked until fixed.",
    "gate.go.ok": "Go gate: no syntax errors (gofmt); the full compilation (go build) ran as advisory — without the dependencies it's not a verdict.",
    "gate.java": "Java gate: architecture (layer rule) verified — compilation (javac) doesn't run in this environment and stays out; nothing blocked by layers.",
    "gate.dodIncomplete": "Definition of done: the project is incomplete ({count} requirement(s) missing) — Apply blocked until resolved.",
    "gate.alsoBlocked": " Also {count} file(s) with errors ({parts}).",
    "gate.blocked": "Gate failed: {count} file(s) blocked{parts}. Fix before applying.",
    "gate.securitySuffix": " · security: {count} bandit advisory(ies) (non-blocking).",
    "gate.part.compile": "{count} compilation/contract",
    "gate.part.syntaxGo": "{count} syntax (gofmt)",
    "gate.part.arch": "{count} architecture (layer rule)",
    "gate.part.security": "{count} security (bandit HIGH)",
    "gate.tscSuffix": " · tsc: {count} type advisory(ies) (advisory — install the deps and run tsc for the full verdict)",
    "gate.goSuffix": " · go build: {count} advisory(ies) (advisory — run go build ./... with the dependencies for the full verdict)",
    "gate.moreSecurity": "… and {count} more advisory(ies) — see the diagnostics log.",
    "gate.couldntRun.policy": "I couldn't run the compilation gate — and the admin policy requires a verified contract. Prepare the environment and re-verify.",
    "gate.couldntRun": "I couldn't run the compilation gate (environment) — nothing was blocked.",
    "smoke.timeout": "Smoke test of the generated tests: time ran out (inconclusive — non-blocking).",
    "smoke.noPython": "Smoke test skipped: Python unavailable to run the generated suite.",
    "smoke.passed": "Smoke test: {count} generated test(s) PASSED in the workspace venv — the project actually runs, not just compiles.",
    "smoke.passedAll": "Smoke test: the generated test(s) PASSED in the workspace venv — the project actually runs, not just compiles.",
    "smoke.failed": "Smoke test: {count} generated test(s) FAILED in the workspace venv — review before applying. (Advisory: the gate doesn't block Apply for this.)",
    "smoke.none": "Smoke test: no tests were collected in the generated suite.",
    "smoke.noPytest": "Smoke test skipped: pytest is not installed in the venv. Run Prepare environment to validate that the generated tests pass.",
    "smoke.importFailed": "Smoke test skipped: I couldn't import all the modules (missing third-party dependencies, or the project needs an editable install). Run Prepare environment — the generated tests haven't been executed yet.",
    "smoke.notPassed": "Smoke test: the generated suite didn't pass (see the FORGE logs in Show logs). Review before applying. (Advisory: doesn't block Apply.)",
    "dialog.ragReindexed": "FORGE RAG: {files} files, {chunks} chunks (mode {mode}).",
    "dialog.role.placeholder": "Your role in the project — adjusts FORGE's style and defaults",
    "role.cientista": "Data scientist",
    "role.engDados": "Data engineer",
    "role.engMl": "ML engineer",
    "role.engIa": "AI engineer",
    "role.engSoftware": "Software engineer",
    "dialog.maxOutput.title": "Maximum output tokens (per session)",
    "dialog.maxOutput.placeholder": "Choose the output cap — high values are lowered to what the gateway serves",
    "dialog.maxOutput.auto": "auto (model catalog)",
    "dialog.maxOutput.tokens": "{label} tokens",
    "dialog.maxOutput.current": "current",
    "dialog.maxOutput.autoDesc": "uses the catalog cap / admin config",
    "dialog.maxOutput.loweredDesc": "lowered to the served window if needed",
    "dialog.langfuse.prompt": "Langfuse secret key (sk-lf-…) — stored in SecretStorage, never in settings",
    "dialog.search.prompt": "Search the internal source ({server})",
    "dialog.search.placeholder": "search terms…",
    "dialog.attach.placeholder": "Attach a workspace file to the context",
    "dialog.run.openFile": "FORGE: open a workspace file to run.",
    "dialog.pytest.installVenv": "pytest is not installed in the environment (.venv). Install now and run the tests?",
    "dialog.pytest.createVenv": "There is no venv in this project. Create .venv with the code's dependencies, install pytest and run the tests?",
    "dialog.pytest.installBtn": "Install and run",
    "dialog.cancel": "Cancel",
    "dialog.deps.detected": "I detected package(s) in the code missing from requirements.txt: {packages}. Add them?",
    "dialog.deps.addBtn": "Add and install",
    "dialog.deps.onlyListedBtn": "Install only what's listed",
    "dialog.diag.exported": "FORGE: diagnostics exported ({count} events, redacted). Attach this file to the bug report.",
    "card.git.openFolder": "### Git\n\nOpen a folder in VS Code to use the git commands.",
    "card.git.untrusted": "### Git\n\n🔒 This workspace is **not trusted** — git commands are disabled (git can execute repository-defined scripts). Trust the folder (bottom-left corner of VS Code) to enable.",
    "card.git.nothingToCommit": "### Git · commit\n\n_Nothing to commit: no **tracked** file was modified. (New files require `git add` first — use the VS Code Git panel.)_",
    "card.git.cancelled": "### Git · commit\n\n_Commit cancelled._",
    "card.git.failed": "### Git\n\nFailed to run: {error}",
    "card.conn.header": "### Connections",
    "card.conn.none": "### Connections\n\nNo connection configured. The admin (or you) declares them in `forge.warehouse.connections` — e.g.: Oracle 19c/26ai/Exadata/ADW (`kind: oracle`, SQLcl/sqlplus), PostgreSQL (`psql`), BigQuery (`bq`), local DuckDB, S3/OCI Object Storage. Passwords live in SecretStorage (asked on first use).",
    "card.conn.cols": "| id | type | target | access | test |",
    "card.conn.rw": "read+write",
    "card.conn.ro": "read-only",
    "card.conn.footer": "_Writes require `readonly:false` ON THE CONNECTION + per-run confirmation; DROP/TRUNCATE never run._",
    "card.sql.openFile": "### Run SQL\n\nOpen a `.sql` file in the editor (the selection, if any, is what runs) and run `/run-sql [connection]`.",
    "card.sql.connNotExists": "### Run SQL\n\nConnection `{id}` doesn't exist — see `/connections`.",
    "card.sql.connUnconfigured": "### Run SQL\n\nConnection not configured — see `/connections`.",
    "card.sql.frame": "### Run SQL · `{id}`\n\n{message}",
    "card.sql.resultTitle": "Result · `{id}`",
    "card.cost.none": "### Cost\n\nNo connection configured — see `/connections`.",
    "card.cost.previewTitle": "Query cost (preview, not executed) · `{id}`",
    "card.cost.previewFrame": "### Cost (preview) · `{id}`\n\n{message}",
    "card.cost.frame": "### Cost · `{id}`\n\n{message}",
    "card.schema.none": "### Warehouse schema\n\nNo connection configured — see `/connections`.",
    "card.schema.frame": "### Warehouse schema · `{id}`\n\n{message}",
    "card.schema.invFailed": "Inventory failed:\n```\n{output}\n```",
    "card.schema.ok": "### Warehouse schema · `{id}`\n\n✅ **{tables} tables** indexed ({columns} columns). The real schema now enters the prompt and the semantic gate — a phantom table/column becomes a finding.\n\n_⚠ Was the sample snapshot capped at {rowCap} rows? No — the inventory uses the SQL's 50k-column cap. Run again after relevant DDLs._",
    "card.parity.frame": "### Data parity\n\n{message}",
    "card.parity.connNotExists": "Connection {id} doesn't exist.",
    "card.parity.profileFailed": "Profile of `{table}` failed:\n```\n{output}\n```",
    "card.data.unknown": "Unknown data command: `{cmd}`.",
    "card.data.failed": "### /{cmd}\n\nFailed: {error}",
    "card.impact.frame": "### Blast radius\n\n{message}",
    "card.impact.noManifest": "### Blast radius\n\nNo dbt grounding: I didn't find `target/manifest.json` in the workspace. Run `dbt parse` (or `dbt compile`) in the dbt project and try again — FORGE reads the real lineage from the manifest.",
    "card.impact.notFound": "The model `{model}` doesn't exist in the dbt manifest.",
    "card.impact.notFoundSug": "The model `{model}` doesn't exist in the dbt manifest — did you mean `{name}`?",
    "card.impact.openModel": "Open a dbt model file in the editor (or use `/impact model_name`).",
    "git.msg.required": "Enter the message: `/git-commit \"your message\"`.",
    "git.msg.tooLong": "Message too long (max. 2000 characters).",
    "git.st.modified": "modified",
    "git.st.added": "added",
    "git.st.deleted": "deleted",
    "git.st.renamed": "renamed",
    "git.st.copied": "copied",
    "git.st.conflict": "conflict",
    "git.st.new": "new",
    "git.st.untracked": "new (untracked)",
    "git.noBranch": "(no branch)",
    "git.ahead": "**{n}** ahead",
    "git.behind": "**{n}** behind",
    "git.clean": "_Working tree clean — nothing to commit._",
    "git.cols": "| file | state |",
    "git.more": "| … | and {n} more |",
    "git.commitHint": "_{n} tracked file(s) would go into a `/git-commit` (new files require `git add` first)._",
    "git.diff.empty": "### Git · diff\n\n_No changes vs. `HEAD` (working tree clean)._",
    "git.diff.truncated": "… (diff truncated)",
    "git.log.empty": "### Git · log\n\n_No commits._",
    "git.log.cols": "| commit | author | when | subject |",
    "git.commit.ok": "✅ Commit created.",
    "git.commit.fail": "❌ Failed.",
    "git.unavailable": "git unavailable or this folder is not a repository.",
    "wh.err.oracleConnect": "Connection \"{id}\": connect must be \"user@tns_alias\" or \"user@//host:port/service\".",
    "wh.err.psqlConnect": "Connection \"{id}\": connect must be the psql URI/DSN.",
    "wh.err.objectStorage": "Connection \"{id}\" is OBJECT STORAGE — it doesn't run SQL. Use /connections to list the contents, or a duckdb connection to query files.",
    "wh.err.unknownKind": "Unknown connection type: {kind}",
    "wh.err.costSingle": "Cost preview accepts only ONE statement — select just the SELECT you want to estimate.",
    "wh.err.costSingleShort": "Cost preview accepts only ONE statement.",
    "wh.err.costUnavailable": "Cost preview not available for this connection type.",
    "wh.result.noOutput": "(no output)",
    "wh.result.capped": " · ⚠ sample capped at {n} rows",
    "wh.result.masked": "_Sensitive values are masked locally before any display (LGPD)._",
    "wh.pwd.title": "Password for connection \"{id}\" ({kind})",
    "wh.pwd.prompt": "Stored in VS Code's SecretStorage (OS keyring) — never in settings or on disk.",
    "wh.err.unsafeField": "Connection \"{id}\": the `{field}` field contains disallowed characters (shell metacharacter) — fix forge.warehouse.connections.",
    "wh.err.unsafeSchema": "Connection \"{id}\": a `schemas` item contains disallowed characters.",
    "wh.err.connNotExists": "Connection \"{id}\" doesn't exist — see /connections.",
    "wh.err.noneConfigured": "No connection configured (forge.warehouse.connections).",
    "wh.err.noneConfiguredShort": "No connection configured.",
    "wh.err.costReadonly": "⛔ Cost preview is read-only — the query contains a write or an unconfirmed statement ({reason}). Run just the SELECT you want to estimate.",
    "wh.err.toolMissing": "The `{tool}` tool is not on PATH. Install it ({hint}) — FORGE uses the CLI you already use, no embedded driver.",
    "wh.err.spawnFailed": "Failed to start {tool}: {error}",
    "wh.hint.sqlcl": "SQLcl — download at oracle.com/sqlcl; connects 19c, 26ai, Exadata and ADW (wallet)",
    "wh.hint.duckdb": "duckdb.org — single binary",
    "wh.hint.default": "install it and ensure it's on PATH",
    "wh.err.schemaBigQuery": "BigQuery requires `schemas` on the connection (datasets to inventory) — INFORMATION_SCHEMA is per dataset.",
    "wh.err.schemaUnavailable": "Schema snapshot not available for this connection type.",
    "val.label.sqlSecurity": "SQL · security",
    "val.label.sqlAntipatterns": "SQL · anti-patterns",
    "val.label.sqlSchema": "SQL · schema (dbt)",
    "par.absent": "(absent)",
    "par.head": "### Data parity · `{left}` × `{right}`",
    "par.ok": "✅ **Parity OK** — {n} metrics match (count, non-nulls and distincts per column).",
    "par.okFooter": "_Comparison by AGGREGATES: no row left the databases (compliance-safe)._",
    "par.diffs": "❌ **{count, plural, one{# divergence} other{# divergences}}** across {total} metrics:",
    "par.cols": "| metric | column | {left} | {right} |",
    "par.more": "_… +{n} divergences._",
    "par.footer": "_Comparison by AGGREGATES: no row left the databases (compliance-safe). Divergence in `count` = volume; in `distintos` = duplicates/dedup; in `nao_nulos` = data loss in the load._",
    "par.usage": "Usage: `/parity table_a table_b` — optionally `connection:table` on each side (cross-warehouse parity).",
    "fin.err.duckdb": "DuckDB is local — there is no warehouse cost history to analyze.",
    "fin.err.unavailable": "Cost report not available for this connection type.",
    "fin.noData": "No data returned. Common causes: missing dictionary privilege (Oracle v$sql), `pg_stat_statements` extension absent (Postgres), or wrong region in the connection's `schemas` (BigQuery).",
    "fin.head": "### Cost · `{id}`",
    "fin.head7d": "### Cost (last 7 days) · `{id}`",
    "fin.hint.bq": "1 TB processed ≈ US$ 6.25 (on-demand). Attack the biggest `tb_processados` first: SELECT * and missing partition filters are the top causes.",
    "fin.hint.oracle": "High `gets_por_exec` = query expensive per run (index/plan); high `execucoes` × average time = candidate for caching/materialization.",
    "fin.hint.other": "High `tempo_total_s` with many `execucoes` = optimize the query; few very slow runs = review plan/indexes.",
    "fin.footer": "_Deterministic source: the warehouse's own metadata — no business data left the database._",
    "conf.alta": "high",
    "conf.media": "medium",
    "conf.baixa": "low",
    "ap.line": "{icon} line {line} [{rule}] (confidence {conf}): {message}",
    "ap.deleteSemWhere": "DELETE without WHERE wipes the whole table — if intentional, use an explicit TRUNCATE and review.",
    "ap.updateSemWhere": "UPDATE without WHERE rewrites ALL rows of the table.",
    "ap.destrutivo": "{kind} is destructive and irreversible — it shouldn't come from generated code without explicit review.",
    "ap.selectStarDbt": "SELECT * in the model propagates any upstream change (silent schema drift) — list the columns.",
    "ap.selectStar": "SELECT * brings unnecessary columns (cost and coupling) — list the columns.",
    "ap.selectStarSub": "SELECT * in a subquery/CTE drags columns nobody asked for — list the columns.",
    "ap.joinImplicito": "Implicit join (FROM a, b + WHERE) — prefer explicit JOIN … ON: a forgotten condition becomes a cartesian product.",
    "ap.produtoCartesiano": "FROM with multiple tables and NO WHERE = cartesian product (N×M rows).",
    "ap.crossJoin": "CROSS JOIN multiplies rows (N×M) — confirm it's intentional (e.g., date spine).",
    "ap.notIn": "NOT IN with a subquery: ONE NULL in the subquery result and the whole query returns zero rows — use NOT EXISTS.",
    "ap.unionSemAll": "UNION (without ALL) deduplicates with an implicit sort — if duplicates are impossible, UNION ALL is cheaper.",
    "ap.orderBySub": "ORDER BY in a subquery without LIMIT doesn't guarantee order in the outer result — it just costs a sort.",
    "ap.likeCuringa": "LIKE '%…' with a leading wildcard prevents index/partition pruning — guaranteed full scan.",
    "ap.inListaGrande": "IN with ~{count} literal items — move them to a temp table/CTE and JOIN.",
    "ap.funcaoEmFiltro": "{fn}(column) in the filter prevents index/pruning (non-sargable predicate) — apply the function to the LITERAL or use an equivalent range.",
    "ap.cteNaoUsada": "The CTE \"{cte}\" is defined and never referenced — dead code that some engines may still execute.",
    "ap.janelaSemPartition": "Window function without PARTITION BY sorts/processes the ENTIRE table in a single partition — confirm the intent.",
    "ap.insertSemColunas": "INSERT without a column list breaks silently when the table schema changes — declare the columns.",
    "ap.limitDbt": "LIMIT in the dbt model goes to PRODUCTION and truncates the dataset — if it was just for development, remove it before applying.",
    "dbt.impact.head": "### Blast radius · `{name}`",
    "dbt.impact.local": "No model, test or exposure depends on `{name}` — a LOCAL-impact change.",
    "dbt.impact.upstream": "Direct upstream: {list}",
    "dbt.impact.downDirect": "| Direct downstream | {n} — {list} |",
    "dbt.impact.downTransitive": "| Transitive downstream | {count, plural, one{# model} other{# models}} (depth {depth}) |",
    "dbt.impact.tests": "| Impacted tests | {n} |",
    "dbt.impact.exposures": "| Exposures | {list} |",
    "dbt.impact.upstreamRow": "| Direct upstream | {list} |",
    "dbt.impact.warning": "A change in `{name}` can break {count, plural, one{# consumer} other{# consumers}} — review the direct downstream before applying (`dbt build --select {name}+` validates the chain).",
    "dbt.impact.freshness": "_Source: target/manifest.json{when} — `dbt parse` or `dbt compile` refreshes the lineage._",
    "dbt.impact.when": " (generated at {ts})",
    "lin.head": "**Column lineage** (confidence {conf}):",
    "lin.cols": "| output | transformation | origin |",
    "lin.more": "_… +{n} columns._",
    "lin.star": "_⚠ The final SELECT uses `*` — columns propagated from upstream don't appear in the map._",
    "lin.direct": "direct",
    "lin.expression": "expression",
    "arch.rule.hexagonal": "the domain must not import adapters/infrastructure — the dependency points INWARD (adapters implement the ports; the domain doesn't know them)",
    "arch.rule.clean": "inner layers (entities/use cases) don't know the outer ones (adapters/frameworks) — the dependency rule points inward",
    "arch.rule.layered": "the model/entity layer must not import service/repository/presentation (each layer only calls the one below)",
    "arch.rule.mvc": "the Model must not import View or Controller (rich Model, unaware of the presentation)",
    "gate.archViolation": "violates the {arch} architecture: {rule}. Forbidden import(s) from the outer layer: {imports}.",
    "pii.head": "### PII / LGPD audit (by column name)",
    "pii.noSchema": "No schema to audit — run `dbt parse` (dbt project) or `/schema-db` (warehouse) first.",
    "pii.clean": "✅ No column with a typical personal-data name across {tables} tables. (Heuristic by NAME — content was not read.)",
    "pii.found": "⚠ **{count, plural, one{# column candidate} other{# column candidates}} for personal data** across {tables} tables (heuristic by NAME — content was not read):",
    "pii.cols": "| table | column | category | confidence |",
    "pii.more": "_… +{n} columns._",
    "pii.next": "Next steps: masking in the warehouse (Oracle: `DBMS_REDACT`/Data Redaction; BigQuery: policy tags + column-level access; Postgres: masked views + per-column GRANT) and minimization in the marts (don't propagate documents/contacts to consumption layers).",
    "pii.footer": "_FORGE already masks samples shown in the chat; the audit guides protection AT THE SOURCE._",
    "pii.cat.doc": "document (CPF/CNPJ/RG)",
    "pii.cat.nome": "person name",
    "pii.cat.email": "e-mail",
    "pii.cat.telefone": "phone",
    "pii.cat.endereco": "address",
    "pii.cat.nascimento": "birth/age",
    "pii.cat.financeiro": "personal finance",
    "pii.cat.cartao": "payment card",
    "pii.cat.credencial": "credential",
    "pii.cat.sensivel": "sensitive data (LGPD art. 5 II)",
    "pii.cat.geo": "geolocation",
    "secrets.weakKeyring": "FORGE: secure credential storage doesn't seem to be available on this system (keyring missing). Credentials may not be protected. Configure a keyring (e.g., gnome-keyring/libsecret) before using in production.",
  },
};
