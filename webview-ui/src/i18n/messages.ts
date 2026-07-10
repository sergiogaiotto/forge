import type { Locale } from "../../../src/shared/locale";

// Catálogo de mensagens da webview por locale. pt-BR é a FONTE (completa); en é override — uma chave
// ausente no en cai para pt-BR (ver t()). Chaves são estáveis e sem acento (namespace.pontos); o TEXTO
// é o que traduz. Superfícies cobertas: App.tsx (piloto), cards da paleta (ctx/tok/sum), Onboarding (ob),
// caixa de código do Markdown (md) e o reducer (charter). DevPanel entra no PR seguinte.
export type MessageKey =
  | "app.loading"
  | "mcp.approve.title"
  | "mcp.approve.before"
  | "mcp.approve.on"
  | "mcp.approve.scope"
  | "common.deny"
  | "common.allow"
  | "help.title"
  | "help.colCommand"
  | "help.colWhat"
  | "help.footer"
  | "cmd.translateSql.prompt"
  | "cmd.parity.usage"
  | "cmd.gitCommit.prompt"
  | "cmd.unknown"
  // /contexto (renderContextReport)
  | "ctx.title"
  | "ctx.colTokens"
  | "ctx.window"
  | "ctx.outputReserve"
  | "ctx.inputBudget"
  | "ctx.pinned"
  | "ctx.history"
  | "ctx.attachments"
  | "ctx.estimate"
  | "ctx.rag"
  | "ctx.session"
  | "ctx.footnote"
  // /tokens (renderTokensReport)
  | "tok.title"
  | "tok.empty"
  | "tok.colIn"
  | "tok.colOut"
  | "tok.last"
  | "tok.session"
  | "tok.footnote"
  // /resumir (renderSummarized)
  | "sum.title"
  | "sum.body"
  // Onboarding
  | "ob.subtitle"
  | "ob.internalNetwork"
  | "ob.step.license"
  | "ob.step.provider"
  | "ob.license.title"
  | "ob.license.sub"
  | "ob.license.valid"
  | "ob.license.verify"
  | "ob.email.label"
  | "ob.email.placeholder"
  | "ob.email.note"
  | "ob.email.confirm"
  | "ob.email.identified"
  | "ob.email.manual"
  | "ob.provider.title"
  | "ob.provider.sub"
  | "ob.provider.test"
  | "ob.provider.finishTitleEmail"
  | "ob.provider.finishTitle"
  | "ob.provider.finish"
  | "ob.field.baseUrl"
  | "ob.field.model"
  | "ob.field.timeout"
  | "ob.field.apiKey"
  | "ob.field.endpoint"
  | "ob.field.dims"
  | "ob.test.connOk"
  | "ob.test.fail"
  | "ob.rag.title"
  | "ob.rag.sub.before"
  | "ob.rag.sub.after"
  | "ob.rag.dimsDefault"
  | "ob.rag.none"
  | "ob.rag.ok"
  | "ob.rag.test"
  | "ob.foot.admin"
  | "ob.foot.network"
  | "ob.foot.secrets"
  | "ob.status.configure"
  | "ob.status.provider"
  // Caixa de código do Markdown (CodeBox)
  | "md.code.lang"
  | "md.code.generating"
  | "md.code.proposalCreated"
  | "md.code.saveTitle"
  | "md.code.saveAsFile"
  | "md.code.copy"
  | "md.code.copied"
  | "md.code.newFile"
  | "md.code.pathPlaceholder"
  | "md.code.confirmTitle"
  | "md.code.save"
  | "md.code.cancel"
  // Reducer (state.ts)
  | "charter.emptyDraft"
  // Comuns (DevPanel)
  | "common.close"
  | "common.cancel"
  | "common.save"
  | "common.loading"
  | "common.generating"
  | "common.dismiss"
  | "common.viewDiff"
  // Seletor de esforço / selects do Modo Projeto
  | "effort.low"
  | "effort.medium"
  | "effort.high"
  | "proj.arch.hexagonal"
  | "proj.arch.clean"
  | "proj.arch.layered"
  | "proj.arch.mvc"
  | "proj.ui.auto"
  | "proj.ui.none"
  | "proj.ui.templateEngine"
  | "proj.ui.spaReact"
  | "proj.ui.streamlit"
  | "proj.fw.auto"
  | "proj.fw.fastapi"
  | "proj.fw.flask"
  | "proj.fw.litestar"
  // Cabeçalho
  | "hdr.licenseActive"
  | "hdr.traceTitle"
  | "hdr.review"
  | "hdr.newChat"
  | "hdr.settings"
  // Estado vazio + barra de contexto
  | "empty.ready"
  | "empty.hint"
  | "empty.counts"
  | "ctxbar.context"
  // Menu de anexos
  | "att.title"
  | "att.editorSelection"
  | "att.terminalSelection"
  | "att.workspaceFile"
  | "att.upload"
  | "att.webBlocked"
  // Compositor
  | "comp.placeholder"
  | "comp.project"
  | "comp.projectTitle"
  | "comp.tddTitle"
  | "comp.langTitle"
  | "comp.archTitle"
  | "comp.uiTitle"
  | "comp.fwTitle"
  | "comp.stop"
  | "comp.send"
  // Barra de status
  | "sb.traceTitle"
  | "sb.ragIndexingTitle"
  | "sb.ragSemanticTitle"
  | "sb.ragLexicalTitle"
  | "sb.ragIndexing"
  | "sb.effortTitle"
  | "sb.effort"
  | "sb.maxOutTitle"
  | "sb.maxOut"
  | "sb.usageTitle"
  // Ecos da paleta (bolha do usuário)
  | "echo.review"
  | "echo.diagramDefault"
  | "echo.summary"
  | "echo.activeFileModel"
  | "echo.translate"
  | "cmd.dialectUnknown"
  // Blueprint do projeto (ProjectPlanPanel)
  | "plan.status.pending"
  | "plan.status.generating"
  | "plan.status.complete"
  | "plan.status.applied"
  | "plan.status.failed"
  | "plan.title"
  | "plan.files"
  | "plan.retry"
  | "plan.planning"
  | "plan.hintDone"
  | "plan.hintReview"
  | "plan.dodHeader"
  | "plan.securityHeader"
  | "plan.noPurpose"
  | "plan.dependsOn"
  | "plan.gateFailedTip"
  | "plan.gateFailedDot"
  | "plan.blocked"
  | "plan.approve"
  | "plan.forceTitle"
  | "plan.force"
  | "plan.applyNoContractTitle"
  | "plan.applyNoContract"
  | "plan.envRequiredTitle"
  | "plan.envRequired"
  | "plan.regateTitle"
  | "plan.regate"
  | "plan.applyAllTitle"
  | "plan.applyAll"
  // Índice (InspectPanel)
  | "insp.title"
  | "insp.ragFiles"
  | "insp.back"
  | "insp.noSkills"
  | "insp.vector"
  | "insp.noVector"
  | "insp.mode"
  | "insp.ready"
  | "insp.indexing"
  | "insp.stats"
  | "insp.cap"
  | "insp.lexical"
  | "insp.nothingIndexed"
  // Charter Wizard
  | "chart.title"
  | "chart.hint"
  | "chart.purpose"
  | "chart.purposePh"
  | "chart.rules"
  | "chart.rulesPh"
  | "chart.fr"
  | "chart.frPh"
  | "chart.nfr"
  | "chart.nfrPh"
  | "chart.draftTitle"
  | "chart.drafting"
  | "chart.draft"
  | "chart.openMd"
  | "chart.openMdTitle"
  | "chart.genTestsTitle"
  | "chart.genTests"
  | "chart.genTestsEcho"
  // Perfil do projeto (ProfilePanel)
  | "prof.title"
  | "prof.stack"
  | "prof.language"
  | "prof.packaging"
  | "prof.lint"
  | "prof.types"
  | "prof.tests"
  | "prof.libs"
  | "prof.nothingDetected"
  | "prof.role"
  | "prof.roleUndefined"
  | "prof.change"
  | "prof.define"
  | "prof.rules"
  | "prof.noRules"
  | "prof.wizard"
  | "prof.wizardTitle"
  // Bloco do assistente
  | "asst.skillApplied"
  | "asst.reasoning"
  | "asst.reasoningLive"
  // Cartão de preview (arquivo chegando)
  | "pv.newFile"
  | "pv.ready"
  | "pv.applyOpen"
  | "pv.availableAfter"
  // Cartão de proposta
  | "prop.cell"
  | "prop.insertCell"
  | "prop.replaceCell"
  | "prop.partialSeal"
  | "prop.completeSeal"
  | "prop.partialSealTitle"
  | "prop.completeSealTitle"
  | "prop.partialWarning"
  | "prop.validationRunning"
  | "prop.validation"
  | "prop.validationFallback"
  | "prop.gateOk"
  | "prop.gateFailed"
  | "prop.unavailable"
  | "prop.cellApplied"
  | "prop.appliedAt"
  | "prop.runCellTitle"
  | "prop.runCell"
  | "prop.previewTitle"
  | "prop.preview"
  | "prop.runningTitle"
  | "prop.running"
  | "prop.runFileTitle"
  | "prop.rerun"
  | "prop.run"
  | "prop.discarded"
  | "prop.applyGateFailedTitle"
  | "prop.applyCellTitle"
  | "prop.applyFileTitle"
  | "prop.forceTitle"
  | "prop.force"
  | "prop.applyPreviewTitle"
  | "prop.applyRunTitle"
  | "prop.applyPreview"
  | "prop.applyRun"
  | "prop.moreActions"
  | "prop.copyContent"
  | "prop.discard"
  // Cartão de execução (RunCard)
  | "run.fallbackTitle"
  | "run.inTerminal"
  | "run.executing"
  | "run.unavailable"
  | "run.npmMissing"
  | "run.outcome.passed"
  | "run.outcome.failed"
  | "run.outcome.noTests"
  | "run.outcome.envMissing"
  | "run.outcome.error"
  | "run.starting"
  | "run.noOutput"
  | "run.viewTerminalTitle"
  | "run.viewTerminal"
  | "run.cancelTitle"
  | "run.installPytestTitle"
  | "run.installPytest"
  | "run.prepareEnvTitle"
  | "run.prepareEnv"
  | "run.fix"
  | "run.hideTitle"
  | "run.hide"
  // Cartão de papel + sugestão de regra
  | "role.defined"
  | "role.relatedSkills"
  | "role.enabled"
  | "role.disabled"
  | "role.chipTitle"
  | "role.notInstalled"
  | "sugg.saveRule"
  // Definição de Pronto (DoD)
  | "dod.ready"
  | "dod.title"
  | "dod.applied"
  | "dod.appliedTitle"
  | "dod.gate"
  | "dod.gateTitle"
  | "dod.run"
  | "dod.runTitle"
  | "dod.tests"
  | "dod.testsTitle"
  | "dod.review"
  | "dod.reviewTitle";

export const MESSAGES: Record<Locale, Partial<Record<MessageKey, string>>> = {
  "pt-BR": {
    "app.loading": "Carregando FORGE…",
    "mcp.approve.title": "Aprovar ferramenta MCP",
    "mcp.approve.before": "O agente quer chamar",
    "mcp.approve.on": "em",
    "mcp.approve.scope": "(escopo {scope}).",
    "common.deny": "Negar",
    "common.allow": "Permitir",
    "help.title": "Paleta de comandos",
    "help.colCommand": "comando",
    "help.colWhat": "o que faz",
    "help.footer": "Digite `/` no chat para autocompletar.",
    "cmd.translateSql.prompt": "Informe o dialeto alvo: `/traduzir-sql <dialeto>` — um de: {dialects}.",
    "cmd.parity.usage": "Uso: `/paridade tabela_a tabela_b` — opcionalmente `conexao:tabela` em cada lado (paridade entre warehouses).",
    "cmd.gitCommit.prompt": "Informe a mensagem: `/git-commit \"sua mensagem de commit\"`. Commita os arquivos rastreados modificados (com confirmação).",
    "cmd.unknown": "Comando desconhecido: `{text}` — digite `/` para ver a paleta ou `/ajuda`.",
    "ctx.title": "Janela de contexto",
    "ctx.colTokens": "tokens",
    "ctx.window": "Janela total",
    "ctx.outputReserve": "Reserva de saída",
    "ctx.inputBudget": "Orçamento de entrada",
    "ctx.pinned": "Fixo (prompt do chat + perfil)",
    "ctx.history": "Histórico ({count, plural, one{# turno} other{# turnos}})",
    "ctx.attachments": "Anexos pendentes ({count})",
    "ctx.estimate": "Ocupação estimada do próximo envio:",
    "ctx.rag": "RAG: {count, plural, one{# chunk indexado} other{# chunks indexados}} (entram por consulta, conforme o orçamento)",
    "ctx.session": "Sessão: {input} tokens de entrada · {output} de saída",
    "ctx.footnote": "Estimativas heurísticas (o tokenizer real varia; TDD/Projeto têm prompt fixo um pouco maior). {clearCmd} zera o histórico.",
    "tok.title": "Uso de tokens",
    "tok.empty": "Ainda não houve geração nesta sessão — os números aparecem após a primeira resposta do modelo.",
    "tok.colIn": "entrada",
    "tok.colOut": "saída",
    "tok.last": "Última geração",
    "tok.session": "Sessão (acumulado)",
    "tok.footnote": "Continuações automáticas somam no acumulado da geração (cada passe reenvia contexto).",
    "sum.title": "Histórico compactado",
    "sum.body":
      "{turns, plural, one{# turno virou} other{# turnos viraram}} o resumo abaixo — é ISTO que o modelo passa a receber como contexto da conversa (a thread acima é só exibição; {clearCmd} zera tudo).",
    "ob.subtitle": "configuração inicial",
    "ob.internalNetwork": "rede interna",
    "ob.step.license": "Licença",
    "ob.step.provider": "Provedor",
    "ob.license.title": "Ativar licença",
    "ob.license.sub": "Cole a chave fornecida pelo admin. A assinatura é verificada localmente (Ed25519) e confirmada no servidor.",
    "ob.license.valid": "Assinatura válida · org {org} · expira em {expiry}",
    "ob.license.verify": "Verificar e ativar",
    "ob.email.label": "Seu e-mail corporativo (obrigatório)",
    "ob.email.placeholder": "voce@claro.com.br",
    "ob.email.note": "A licença não identifica você automaticamente. O e-mail é usado como sua identidade na observabilidade (Langfuse).",
    "ob.email.confirm": "Confirmar e-mail",
    "ob.email.identified": "Identificado como {email}",
    "ob.email.manual": "(informado)",
    "ob.provider.title": "Escolher provedor",
    "ob.provider.sub": "Selecione o backend de modelo. O HubGPU usa o endpoint OpenAI-compatible.",
    "ob.provider.test": "Testar conexão",
    "ob.provider.finishTitleEmail": "Informe seu e-mail antes de concluir",
    "ob.provider.finishTitle": "Concluir",
    "ob.provider.finish": "Concluir configuração",
    "ob.field.baseUrl": "Base URL",
    "ob.field.model": "Modelo",
    "ob.field.timeout": "Timeout (s)",
    "ob.field.apiKey": "API Key",
    "ob.field.endpoint": "Endpoint",
    "ob.field.dims": "Densidade",
    "ob.test.connOk": "Conexão OK",
    "ob.test.fail": "Falha: {message}",
    "ob.rag.title": "Embeddings (RAG)",
    "ob.rag.sub.before": "Busca semântica do codebase. O sufixo",
    "ob.rag.sub.after": "é adicionado pelo client — configure só a base.",
    "ob.rag.dimsDefault": "padrão (1024)",
    "ob.rag.none": "Sem endpoint — recuperação lexical (BM25), 100% offline.",
    "ob.rag.ok": "Embeddings OK · {dims} dims",
    "ob.rag.test": "Testar embedding",
    "ob.foot.admin": "Observabilidade, skills e catálogo de MCP são geridos pelo admin.",
    "ob.foot.network": "Implantação em rede interna — sem conexão externa.",
    "ob.foot.secrets": "Licença e credenciais ficam no SecretStorage. Nada em settings.json.",
    "ob.status.configure": "FORGE · configurar",
    "ob.status.provider": "Provedor: definindo…",
    "md.code.lang": "código",
    "md.code.generating": "gerando…",
    "md.code.proposalCreated": "proposta criada",
    "md.code.saveTitle": "Salvar este código como um arquivo (vira uma proposta aplicável, com diff e gate)",
    "md.code.saveAsFile": "Salvar como arquivo",
    "md.code.copy": "Copiar",
    "md.code.copied": "Copiado",
    "md.code.newFile": "novo_arquivo.{ext}",
    "md.code.pathPlaceholder": "caminho/relativo/arquivo.ext",
    "md.code.confirmTitle": "Criar a proposta aplicável",
    "md.code.save": "Salvar",
    "md.code.cancel": "Cancelar",
    "charter.emptyDraft": "O modelo não retornou conteúdo para a seção. Tente de novo.",
    "common.close": "Fechar",
    "common.cancel": "Cancelar",
    "common.save": "Salvar",
    "common.loading": "carregando…",
    "common.generating": "gerando…",
    "common.dismiss": "Dispensar",
    "common.viewDiff": "Ver diff",
    "effort.low": "baixo",
    "effort.medium": "médio",
    "effort.high": "alto",
    "proj.arch.hexagonal": "Hexagonal",
    "proj.arch.clean": "Clean",
    "proj.arch.layered": "Camadas",
    "proj.arch.mvc": "MVC",
    "proj.ui.auto": "UI: auto",
    "proj.ui.none": "Sem UI",
    "proj.ui.templateEngine": "Template engine",
    "proj.ui.spaReact": "SPA React",
    "proj.ui.streamlit": "Streamlit",
    "proj.fw.auto": "Framework: auto",
    "proj.fw.fastapi": "FastAPI",
    "proj.fw.flask": "Flask",
    "proj.fw.litestar": "Litestar",
    "hdr.licenseActive": "Licença ativa",
    "hdr.traceTitle": "Observabilidade ativa · registrado como \"{user}\" no Langfuse (gerido pelo admin)",
    "hdr.review": "Revisar alterações (IA in-network)",
    "hdr.newChat": "Nova conversa (limpa também o histórico e os anexos enviados ao modelo)",
    "hdr.settings": "Configurações",
    "empty.ready": "Pronto para gerar.",
    "empty.hint": "Descreva a tarefa — ex.: \"Limpe o churn.parquet: remova duplicados, ajuste tipos e trate nulos com segurança.\"",
    "empty.counts": "{skills} skills ativas · {mcp} MCP in-network",
    "ctxbar.context": "Contexto: editor ativo · {skills} skills habilitadas",
    "att.title": "Anexar contexto (arquivo, seleção, upload)",
    "att.editorSelection": "Anexar seleção do editor",
    "att.terminalSelection": "Anexar seleção do terminal",
    "att.workspaceFile": "Anexar arquivo do workspace",
    "att.upload": "Enviar do computador",
    "att.webBlocked": "Buscar na web · bloqueada (rede interna)",
    "comp.placeholder": "Pergunte ou descreva a tarefa… (@ para arquivos, / para comandos)",
    "comp.project": "Projeto",
    "comp.projectTitle": "Modo Projeto: gera um projeto COMPLETO na linguagem e arquitetura escolhidas",
    "comp.tddTitle": "Modo TDD: escreve o teste primeiro, depois a implementação",
    "comp.langTitle": "Linguagem",
    "comp.archTitle": "Arquitetura",
    "comp.uiTitle": "Camada de UI do projeto (opcional): auto deixa o modelo decidir; as demais viram instrução explícita no blueprint e na geração",
    "comp.fwTitle": "Framework web do projeto Python (opcional): auto deixa o modelo decidir; FastAPI, Flask ou Litestar viram instrução explícita",
    "comp.stop": "Parar",
    "comp.send": "Enviar",
    "sb.traceTitle": "Telemetria ativa · usuário \"{user}\"",
    "sb.ragIndexingTitle": "Indexando o codebase…",
    "sb.ragSemanticTitle": "Busca semântica · {model} · {files} arquivos",
    "sb.ragLexicalTitle": "BM25 lexical (sem embeddings) · {files} arquivos",
    "sb.ragIndexing": "RAG indexando…",
    "sb.effortTitle": "Esforço de raciocínio do gpt-oss — clique para alternar (baixo → médio → alto). Esforço maior raciocina mais e eleva o timeout automaticamente.",
    "sb.effort": "esforço: {level}",
    "sb.maxOutTitle": "Máximo de tokens de saída — clique para alternar (auto → 16k → 32k → 64k → 128k). Valores altos são rebaixados automaticamente ao que o gateway serve (sem erro).",
    "sb.maxOut": "saída: {label}",
    "sb.usageTitle": "Tokens da sessão — entrada: {sessionIn} · saída: {sessionOut} (última geração: {lastIn}/{lastOut}). Digite /tokens para o detalhe.",
    "echo.review": "Revisar minhas alterações (git diff).",
    "echo.diagramDefault": "arquitetura do projeto",
    "echo.summary": "Gerar a documentação funcional do projeto.",
    "echo.activeFileModel": "modelo do arquivo ativo",
    "echo.translate": "arquivo ativo → {dialect}",
    "cmd.dialectUnknown": "Dialeto `{dialect}` não reconhecido — use um de: {dialects}.",
    "plan.status.pending": "pendente",
    "plan.status.generating": "gerando…",
    "plan.status.complete": "gerado",
    "plan.status.applied": "aplicado",
    "plan.status.failed": "não gerado",
    "plan.title": "Blueprint do projeto",
    "plan.files": "{count} arquivos",
    "plan.retry": "Tentar de novo",
    "plan.planning": "Planejando o projeto…",
    "plan.hintDone": "Arquivos gerados. Clique em “Aplicar tudo” para gravá-los no workspace, ou feche para revisar antes.",
    "plan.hintReview": "Revise os arquivos abaixo — passe o mouse para ver o objetivo e as dependências de cada um. “Aprovar e gerar” cria todos na ordem de dependência; “Cancelar” descarta o plano.",
    "plan.dodHeader": "Definição de pronto — Aplicar bloqueado até fechar:",
    "plan.securityHeader": "Segurança (bandit) — avisos (não bloqueiam):",
    "plan.noPurpose": "(sem descrição)",
    "plan.dependsOn": "Depende de: {deps}",
    "plan.gateFailedTip": "Gate reprovou:",
    "plan.gateFailedDot": "gate reprovou",
    "plan.blocked": "bloqueado",
    "plan.approve": "Aprovar e gerar",
    "plan.forceTitle": "Aplicar também os arquivos que o gate reprovou — você revisou e assume. Fica registrado no diagnóstico.",
    "plan.force": "Forçar bloqueados",
    "plan.applyNoContractTitle": "O mypy não verificou o contrato cross-file (import/atributo fantasma). Aplicar assim mesmo — você revisou e assume. Fica registrado no diagnóstico.",
    "plan.applyNoContract": "Aplicar sem verificar contrato",
    "plan.envRequiredTitle": "Política do admin: o contrato cross-file precisa ser verificado (mypy) antes de aplicar — sem escape. Preparar o ambiente cria o venv; depois clique em Re-verificar contrato.",
    "plan.envRequired": "Verificação exigida — Preparar ambiente",
    "plan.regateTitle": "Re-rodar a verificação (compileall/mypy) sobre as propostas já geradas — sem regenerar. Use depois de Preparar ambiente.",
    "plan.regate": "Re-verificar contrato",
    "plan.applyAllTitle": "Aplicar todos os arquivos gerados, na ordem de dependência",
    "plan.applyAll": "Aplicar tudo",
    "insp.title": "Índice · o que o FORGE injeta",
    "insp.ragFiles": "· {count} arq.",
    "insp.back": "← voltar",
    "insp.noSkills": "nenhuma skill",
    "insp.vector": "vetor ✓",
    "insp.noVector": "sem vetor",
    "insp.mode": "modo",
    "insp.ready": "pronto",
    "insp.indexing": "indexando…",
    "insp.stats": "{files} arquivos · {chunks} chunks",
    "insp.cap": "(teto {max})",
    "insp.lexical": "BM25 lexical (sem embeddings)",
    "insp.nothingIndexed": "nada indexado",
    "chart.title": "Charter do projeto",
    "chart.hint": "Redija com o modelo e salve — o charter vira contexto fixo (pinned) em toda geração do FORGE.",
    "chart.purpose": "Propósito",
    "chart.purposePh": "O que a aplicação faz, para quem e qual o valor…",
    "chart.rules": "Regras do projeto",
    "chart.rulesPh": "- sempre use type hints\n- nunca logue segredos",
    "chart.fr": "Requisitos funcionais",
    "chart.frPh": "- RF-01: o sistema deve autenticar via licença Ed25519",
    "chart.nfr": "Requisitos não funcionais",
    "chart.nfrPh": "- RNF-01: p95 < 200ms\n- RNF-02: LGPD — sem PII em logs",
    "chart.draftTitle": "Redigir/estruturar esta seção com o modelo, a partir do que você escreveu",
    "chart.drafting": "redigindo…",
    "chart.draft": "Redigir com IA",
    "chart.openMd": "abrir .md",
    "chart.openMdTitle": "Abrir o .forge/project.md cru no editor",
    "chart.genTestsTitle": "Gerar testes de aceitação (test-first) a partir dos Requisitos Funcionais/Não Funcionais",
    "chart.genTests": "Gerar testes",
    "chart.genTestsEcho": "Gerar testes de aceitação a partir destes requisitos:",
    "prof.title": "Perfil do projeto",
    "prof.stack": "Stack detectada · automática",
    "prof.language": "Linguagem",
    "prof.packaging": "Pacotes",
    "prof.lint": "Lint/format",
    "prof.types": "Tipos",
    "prof.tests": "Testes",
    "prof.libs": "Libs",
    "prof.nothingDetected": "nada detectado neste workspace",
    "prof.role": "Papel",
    "prof.roleUndefined": "não definido",
    "prof.change": "Alterar",
    "prof.define": "Definir",
    "prof.rules": "Regras · {count}",
    "prof.noRules": "nenhuma regra ainda",
    "prof.wizard": "Editar com wizard",
    "prof.wizardTitle": "Redigir propósito, regras e requisitos com o modelo",
    "asst.skillApplied": "Skill aplicada · {name}",
    "asst.reasoning": "Raciocínio",
    "asst.reasoningLive": "Raciocinando…",
    "pv.newFile": "novo arquivo…",
    "pv.ready": "pronto",
    "pv.applyOpen": "Aplicar e abrir",
    "pv.availableAfter": "Disponível assim que a geração concluir",
    "prop.cell": "célula",
    "prop.insertCell": "Inserir célula",
    "prop.replaceCell": "Substituir célula [{index}]",
    "prop.partialSeal": "⚠ parcial",
    "prop.completeSeal": "✓ completo",
    "prop.partialSealTitle": "Geração parcial — o arquivo pode estar incompleto",
    "prop.completeSealTitle": "Arquivo completo (sem truncamento nem elipses)",
    "prop.partialWarning": "Geração parcial — o arquivo pode estar incompleto. Peça para continuar ou regenerar antes de aplicar.",
    "prop.validationRunning": "Validação local · executando…",
    "prop.validation": "Validação local",
    "prop.validationFallback": "validação",
    "prop.gateOk": "gate ok",
    "prop.gateFailed": "gate reprovado",
    "prop.unavailable": "{labels} indisponível",
    "prop.cellApplied": "Célula aplicada",
    "prop.appliedAt": "Aplicado em {path}",
    "prop.runCellTitle": "Executar esta célula (captura a saída)",
    "prop.runCell": "Executar célula",
    "prop.previewTitle": "Abrir o preview deste arquivo (painel ao lado)",
    "prop.preview": "Visualizar",
    "prop.runningTitle": "Execução em andamento",
    "prop.running": "Executando…",
    "prop.runFileTitle": "Executar este arquivo no terminal (com auto-cura)",
    "prop.rerun": "Reexecutar",
    "prop.run": "Executar",
    "prop.discarded": "Descartado.",
    "prop.applyGateFailedTitle": "Quality gate reprovado — corrija antes de aplicar",
    "prop.applyCellTitle": "Aplicar a célula e abrir o notebook",
    "prop.applyFileTitle": "Gravar o arquivo e abri-lo no editor",
    "prop.forceTitle": "Aplicar por cima do gate reprovado — você revisou e assume a responsabilidade. Fica registrado no diagnóstico.",
    "prop.force": "Aplicar assim mesmo, revisei",
    "prop.applyPreviewTitle": "Gravar o arquivo e abrir o preview",
    "prop.applyRunTitle": "Aplicar o arquivo e executá-lo no terminal",
    "prop.applyPreview": "Aplicar e visualizar",
    "prop.applyRun": "Aplicar e executar",
    "prop.moreActions": "Mais ações",
    "prop.copyContent": "Copiar conteúdo",
    "prop.discard": "Descartar",
    "run.fallbackTitle": "execução",
    "run.inTerminal": "no terminal",
    "run.executing": "executando",
    "run.unavailable": "indisponível",
    "run.npmMissing": "runner ausente — rode npm install",
    "run.outcome.passed": "testes verdes",
    "run.outcome.failed": "testes falharam",
    "run.outcome.noTests": "nenhum teste coletado",
    "run.outcome.envMissing": "pytest ausente no ambiente",
    "run.outcome.error": "erro do pytest (exit {code})",
    "run.starting": "iniciando…",
    "run.noOutput": "(sem saída)",
    "run.viewTerminalTitle": "Focar o terminal de execução",
    "run.viewTerminal": "Ver no terminal",
    "run.cancelTitle": "Interromper a execução",
    "run.installPytestTitle": "Instalar o pytest no venv do projeto (cria o .venv se preciso) e rodar os testes",
    "run.installPytest": "Instalar pytest e rodar",
    "run.prepareEnvTitle": "Criar o venv e instalar as dependências detectadas (depois clique em Reexecutar)",
    "run.prepareEnv": "Preparar ambiente",
    "run.fix": "Corrigir com FORGE",
    "run.hideTitle": "Ocultar este cartão da conversa",
    "run.hide": "Ocultar",
    "role.defined": "Papel definido:",
    "role.relatedSkills": "skills relacionadas:",
    "role.enabled": "habilitada",
    "role.disabled": "desabilitada",
    "role.chipTitle": "{name} · {state} — clique para ver o SKILL.md no Índice",
    "role.notInstalled": "{name} · não instalada neste ambiente",
    "sugg.saveRule": "Salvar como regra do projeto?",
    "dod.ready": "Pronto",
    "dod.title": "Definição de Pronto",
    "dod.applied": "Aplicado",
    "dod.appliedTitle": "Há alteração aplicada ao arquivo",
    "dod.gate": "Gate",
    "dod.gateTitle": "Validação local (lint/tipos) da última alteração aplicada",
    "dod.run": "Executa",
    "dod.runTitle": "Executar o último arquivo aplicado",
    "dod.tests": "Testes",
    "dod.testsTitle": "Rodar a suíte de testes",
    "dod.review": "Revisão",
    "dod.reviewTitle": "Revisar as alterações (IA in-network)",
  },
  en: {
    "app.loading": "Loading FORGE…",
    "mcp.approve.title": "Approve MCP tool",
    "mcp.approve.before": "The agent wants to call",
    "mcp.approve.on": "on",
    "mcp.approve.scope": "(scope {scope}).",
    "common.deny": "Deny",
    "common.allow": "Allow",
    "help.title": "Command palette",
    "help.colCommand": "command",
    "help.colWhat": "what it does",
    "help.footer": "Type `/` in the chat to autocomplete.",
    "cmd.translateSql.prompt": "Enter the target dialect: `/translate-sql <dialect>` — one of: {dialects}.",
    "cmd.parity.usage": "Usage: `/parity table_a table_b` — optionally `connection:table` on each side (cross-warehouse parity).",
    "cmd.gitCommit.prompt": "Enter the message: `/git-commit \"your commit message\"`. Commits the modified tracked files (with confirmation).",
    "cmd.unknown": "Unknown command: `{text}` — type `/` to see the palette or `/help`.",
    "ctx.title": "Context window",
    "ctx.colTokens": "tokens",
    "ctx.window": "Total window",
    "ctx.outputReserve": "Output reserve",
    "ctx.inputBudget": "Input budget",
    "ctx.pinned": "Fixed (chat prompt + profile)",
    "ctx.history": "History ({count, plural, one{# turn} other{# turns}})",
    "ctx.attachments": "Pending attachments ({count})",
    "ctx.estimate": "Estimated occupancy of the next send:",
    "ctx.rag": "RAG: {count, plural, one{# indexed chunk} other{# indexed chunks}} (added per query, within the budget)",
    "ctx.session": "Session: {input} input tokens · {output} output",
    "ctx.footnote": "Heuristic estimates (the real tokenizer varies; TDD/Project modes have a slightly larger fixed prompt). {clearCmd} clears the history.",
    "tok.title": "Token usage",
    "tok.empty": "No generation in this session yet — the numbers appear after the model's first response.",
    "tok.colIn": "input",
    "tok.colOut": "output",
    "tok.last": "Last generation",
    "tok.session": "Session (cumulative)",
    "tok.footnote": "Automatic continuations add to the generation total (each pass resends context).",
    "sum.title": "History compacted",
    "sum.body":
      "{turns, plural, one{# turn became} other{# turns became}} the summary below — THIS is what the model now receives as the conversation context (the thread above is display only; {clearCmd} resets everything).",
    "ob.subtitle": "initial setup",
    "ob.internalNetwork": "internal network",
    "ob.step.license": "License",
    "ob.step.provider": "Provider",
    "ob.license.title": "Activate license",
    "ob.license.sub": "Paste the key provided by the admin. The signature is verified locally (Ed25519) and confirmed on the server.",
    "ob.license.valid": "Valid signature · org {org} · expires on {expiry}",
    "ob.license.verify": "Verify and activate",
    "ob.email.label": "Your corporate e-mail (required)",
    "ob.email.placeholder": "you@claro.com.br",
    "ob.email.note": "The license does not identify you automatically. The e-mail is used as your identity in observability (Langfuse).",
    "ob.email.confirm": "Confirm e-mail",
    "ob.email.identified": "Identified as {email}",
    "ob.email.manual": "(entered manually)",
    "ob.provider.title": "Choose provider",
    "ob.provider.sub": "Select the model backend. HubGPU uses the OpenAI-compatible endpoint.",
    "ob.provider.test": "Test connection",
    "ob.provider.finishTitleEmail": "Enter your e-mail before finishing",
    "ob.provider.finishTitle": "Finish",
    "ob.provider.finish": "Finish setup",
    "ob.field.baseUrl": "Base URL",
    "ob.field.model": "Model",
    "ob.field.timeout": "Timeout (s)",
    "ob.field.apiKey": "API Key",
    "ob.field.endpoint": "Endpoint",
    "ob.field.dims": "Dimensions",
    "ob.test.connOk": "Connection OK",
    "ob.test.fail": "Failed: {message}",
    "ob.rag.title": "Embeddings (RAG)",
    "ob.rag.sub.before": "Semantic codebase search. The",
    "ob.rag.sub.after": "suffix is added by the client — configure only the base.",
    "ob.rag.dimsDefault": "default (1024)",
    "ob.rag.none": "No endpoint — lexical retrieval (BM25), 100% offline.",
    "ob.rag.ok": "Embeddings OK · {dims} dims",
    "ob.rag.test": "Test embedding",
    "ob.foot.admin": "Observability, skills and the MCP catalog are admin-managed.",
    "ob.foot.network": "Internal-network deployment — no external connection.",
    "ob.foot.secrets": "License and credentials live in SecretStorage. Nothing in settings.json.",
    "ob.status.configure": "FORGE · configure",
    "ob.status.provider": "Provider: choosing…",
    "md.code.lang": "code",
    "md.code.generating": "generating…",
    "md.code.proposalCreated": "proposal created",
    "md.code.saveTitle": "Save this code as a file (it becomes an applicable proposal, with diff and gate)",
    "md.code.saveAsFile": "Save as file",
    "md.code.copy": "Copy",
    "md.code.copied": "Copied",
    "md.code.newFile": "new_file.{ext}",
    "md.code.pathPlaceholder": "relative/path/file.ext",
    "md.code.confirmTitle": "Create the applicable proposal",
    "md.code.save": "Save",
    "md.code.cancel": "Cancel",
    "charter.emptyDraft": "The model returned no content for the section. Try again.",
    "common.close": "Close",
    "common.cancel": "Cancel",
    "common.save": "Save",
    "common.loading": "loading…",
    "common.generating": "generating…",
    "common.dismiss": "Dismiss",
    "common.viewDiff": "View diff",
    "effort.low": "low",
    "effort.medium": "medium",
    "effort.high": "high",
    "proj.arch.hexagonal": "Hexagonal",
    "proj.arch.clean": "Clean",
    "proj.arch.layered": "Layers",
    "proj.arch.mvc": "MVC",
    "proj.ui.auto": "UI: auto",
    "proj.ui.none": "No UI",
    "proj.ui.templateEngine": "Template engine",
    "proj.ui.spaReact": "SPA React",
    "proj.ui.streamlit": "Streamlit",
    "proj.fw.auto": "Framework: auto",
    "proj.fw.fastapi": "FastAPI",
    "proj.fw.flask": "Flask",
    "proj.fw.litestar": "Litestar",
    "hdr.licenseActive": "Active license",
    "hdr.traceTitle": "Observability active · recorded as \"{user}\" in Langfuse (admin-managed)",
    "hdr.review": "Review changes (in-network AI)",
    "hdr.newChat": "New conversation (also clears the history and attachments sent to the model)",
    "hdr.settings": "Settings",
    "empty.ready": "Ready to generate.",
    "empty.hint": "Describe the task — e.g. \"Clean churn.parquet: remove duplicates, fix types and handle nulls safely.\"",
    "empty.counts": "{skills} active skills · {mcp} in-network MCP",
    "ctxbar.context": "Context: active editor · {skills} skills enabled",
    "att.title": "Attach context (file, selection, upload)",
    "att.editorSelection": "Attach editor selection",
    "att.terminalSelection": "Attach terminal selection",
    "att.workspaceFile": "Attach workspace file",
    "att.upload": "Upload from computer",
    "att.webBlocked": "Web search · blocked (internal network)",
    "comp.placeholder": "Ask or describe the task… (@ for files, / for commands)",
    "comp.project": "Project",
    "comp.projectTitle": "Project Mode: generates a COMPLETE project in the chosen language and architecture",
    "comp.tddTitle": "TDD Mode: writes the test first, then the implementation",
    "comp.langTitle": "Language",
    "comp.archTitle": "Architecture",
    "comp.uiTitle": "Project UI layer (optional): auto lets the model decide; the others become an explicit instruction in the blueprint and generation",
    "comp.fwTitle": "Python project's web framework (optional): auto lets the model decide; FastAPI, Flask or Litestar become an explicit instruction",
    "comp.stop": "Stop",
    "comp.send": "Send",
    "sb.traceTitle": "Telemetry active · user \"{user}\"",
    "sb.ragIndexingTitle": "Indexing the codebase…",
    "sb.ragSemanticTitle": "Semantic search · {model} · {files} files",
    "sb.ragLexicalTitle": "Lexical BM25 (no embeddings) · {files} files",
    "sb.ragIndexing": "RAG indexing…",
    "sb.effortTitle": "gpt-oss reasoning effort — click to cycle (low → medium → high). Higher effort reasons more and raises the timeout automatically.",
    "sb.effort": "effort: {level}",
    "sb.maxOutTitle": "Maximum output tokens — click to cycle (auto → 16k → 32k → 64k → 128k). High values are automatically lowered to what the gateway serves (no error).",
    "sb.maxOut": "output: {label}",
    "sb.usageTitle": "Session tokens — input: {sessionIn} · output: {sessionOut} (last generation: {lastIn}/{lastOut}). Type /tokens for details.",
    "echo.review": "Review my changes (git diff).",
    "echo.diagramDefault": "project architecture",
    "echo.summary": "Generate the project's functional documentation.",
    "echo.activeFileModel": "active file's model",
    "echo.translate": "active file → {dialect}",
    "cmd.dialectUnknown": "Dialect `{dialect}` not recognized — use one of: {dialects}.",
    "plan.status.pending": "pending",
    "plan.status.generating": "generating…",
    "plan.status.complete": "generated",
    "plan.status.applied": "applied",
    "plan.status.failed": "not generated",
    "plan.title": "Project blueprint",
    "plan.files": "{count} files",
    "plan.retry": "Try again",
    "plan.planning": "Planning the project…",
    "plan.hintDone": "Files generated. Click “Apply all” to write them to the workspace, or close to review first.",
    "plan.hintReview": "Review the files below — hover to see each one's purpose and dependencies. “Approve and generate” creates them all in dependency order; “Cancel” discards the plan.",
    "plan.dodHeader": "Definition of done — Apply blocked until resolved:",
    "plan.securityHeader": "Security (bandit) — advisories (non-blocking):",
    "plan.noPurpose": "(no description)",
    "plan.dependsOn": "Depends on: {deps}",
    "plan.gateFailedTip": "Gate failed:",
    "plan.gateFailedDot": "gate failed",
    "plan.blocked": "blocked",
    "plan.approve": "Approve and generate",
    "plan.forceTitle": "Apply also the files the gate failed — you reviewed and take responsibility. Recorded in diagnostics.",
    "plan.force": "Force blocked",
    "plan.applyNoContractTitle": "mypy did not verify the cross-file contract (phantom import/attribute). Apply anyway — you reviewed and take responsibility. Recorded in diagnostics.",
    "plan.applyNoContract": "Apply without verifying the contract",
    "plan.envRequiredTitle": "Admin policy: the cross-file contract must be verified (mypy) before applying — no escape. Prepare environment creates the venv; then click Re-verify contract.",
    "plan.envRequired": "Verification required — Prepare environment",
    "plan.regateTitle": "Re-run the verification (compileall/mypy) over the proposals already generated — without regenerating. Use after Prepare environment.",
    "plan.regate": "Re-verify contract",
    "plan.applyAllTitle": "Apply all generated files, in dependency order",
    "plan.applyAll": "Apply all",
    "insp.title": "Index · what FORGE injects",
    "insp.ragFiles": "· {count} files",
    "insp.back": "← back",
    "insp.noSkills": "no skills",
    "insp.vector": "vector ✓",
    "insp.noVector": "no vector",
    "insp.mode": "mode",
    "insp.ready": "ready",
    "insp.indexing": "indexing…",
    "insp.stats": "{files} files · {chunks} chunks",
    "insp.cap": "(cap {max})",
    "insp.lexical": "Lexical BM25 (no embeddings)",
    "insp.nothingIndexed": "nothing indexed",
    "chart.title": "Project charter",
    "chart.hint": "Draft with the model and save — the charter becomes pinned context in every FORGE generation.",
    "chart.purpose": "Purpose",
    "chart.purposePh": "What the application does, for whom and what value…",
    "chart.rules": "Project rules",
    "chart.rulesPh": "- always use type hints\n- never log secrets",
    "chart.fr": "Functional requirements",
    "chart.frPh": "- RF-01: the system must authenticate via Ed25519 license",
    "chart.nfr": "Non-functional requirements",
    "chart.nfrPh": "- RNF-01: p95 < 200ms\n- RNF-02: LGPD — no PII in logs",
    "chart.draftTitle": "Draft/structure this section with the model, from what you wrote",
    "chart.drafting": "drafting…",
    "chart.draft": "Draft with AI",
    "chart.openMd": "open .md",
    "chart.openMdTitle": "Open the raw .forge/project.md in the editor",
    "chart.genTestsTitle": "Generate acceptance tests (test-first) from the Functional/Non-Functional Requirements",
    "chart.genTests": "Generate tests",
    "chart.genTestsEcho": "Generate acceptance tests from these requirements:",
    "prof.title": "Project profile",
    "prof.stack": "Detected stack · automatic",
    "prof.language": "Language",
    "prof.packaging": "Packaging",
    "prof.lint": "Lint/format",
    "prof.types": "Types",
    "prof.tests": "Tests",
    "prof.libs": "Libs",
    "prof.nothingDetected": "nothing detected in this workspace",
    "prof.role": "Role",
    "prof.roleUndefined": "not set",
    "prof.change": "Change",
    "prof.define": "Set",
    "prof.rules": "Rules · {count}",
    "prof.noRules": "no rules yet",
    "prof.wizard": "Edit with wizard",
    "prof.wizardTitle": "Draft purpose, rules and requirements with the model",
    "asst.skillApplied": "Skill applied · {name}",
    "asst.reasoning": "Reasoning",
    "asst.reasoningLive": "Reasoning…",
    "pv.newFile": "new file…",
    "pv.ready": "ready",
    "pv.applyOpen": "Apply and open",
    "pv.availableAfter": "Available as soon as generation completes",
    "prop.cell": "cell",
    "prop.insertCell": "Insert cell",
    "prop.replaceCell": "Replace cell [{index}]",
    "prop.partialSeal": "⚠ partial",
    "prop.completeSeal": "✓ complete",
    "prop.partialSealTitle": "Partial generation — the file may be incomplete",
    "prop.completeSealTitle": "Complete file (no truncation or ellipses)",
    "prop.partialWarning": "Partial generation — the file may be incomplete. Ask to continue or regenerate before applying.",
    "prop.validationRunning": "Local validation · running…",
    "prop.validation": "Local validation",
    "prop.validationFallback": "validation",
    "prop.gateOk": "gate ok",
    "prop.gateFailed": "gate failed",
    "prop.unavailable": "{labels} unavailable",
    "prop.cellApplied": "Cell applied",
    "prop.appliedAt": "Applied to {path}",
    "prop.runCellTitle": "Run this cell (captures the output)",
    "prop.runCell": "Run cell",
    "prop.previewTitle": "Open this file's preview (side panel)",
    "prop.preview": "Preview",
    "prop.runningTitle": "Run in progress",
    "prop.running": "Running…",
    "prop.runFileTitle": "Run this file in the terminal (with self-healing)",
    "prop.rerun": "Re-run",
    "prop.run": "Run",
    "prop.discarded": "Discarded.",
    "prop.applyGateFailedTitle": "Quality gate failed — fix before applying",
    "prop.applyCellTitle": "Apply the cell and open the notebook",
    "prop.applyFileTitle": "Write the file and open it in the editor",
    "prop.forceTitle": "Apply over the failed gate — you reviewed and take responsibility. Recorded in diagnostics.",
    "prop.force": "Apply anyway, I reviewed",
    "prop.applyPreviewTitle": "Write the file and open the preview",
    "prop.applyRunTitle": "Apply the file and run it in the terminal",
    "prop.applyPreview": "Apply and preview",
    "prop.applyRun": "Apply and run",
    "prop.moreActions": "More actions",
    "prop.copyContent": "Copy content",
    "prop.discard": "Discard",
    "run.fallbackTitle": "run",
    "run.inTerminal": "in terminal",
    "run.executing": "running",
    "run.unavailable": "unavailable",
    "run.npmMissing": "runner missing — run npm install",
    "run.outcome.passed": "tests green",
    "run.outcome.failed": "tests failed",
    "run.outcome.noTests": "no tests collected",
    "run.outcome.envMissing": "pytest missing from the environment",
    "run.outcome.error": "pytest error (exit {code})",
    "run.starting": "starting…",
    "run.noOutput": "(no output)",
    "run.viewTerminalTitle": "Focus the run terminal",
    "run.viewTerminal": "View in terminal",
    "run.cancelTitle": "Stop the run",
    "run.installPytestTitle": "Install pytest in the project venv (creates .venv if needed) and run the tests",
    "run.installPytest": "Install pytest and run",
    "run.prepareEnvTitle": "Create the venv and install the detected dependencies (then click Re-run)",
    "run.prepareEnv": "Prepare environment",
    "run.fix": "Fix with FORGE",
    "run.hideTitle": "Hide this card from the conversation",
    "run.hide": "Hide",
    "role.defined": "Role set:",
    "role.relatedSkills": "related skills:",
    "role.enabled": "enabled",
    "role.disabled": "disabled",
    "role.chipTitle": "{name} · {state} — click to view the SKILL.md in the Index",
    "role.notInstalled": "{name} · not installed in this environment",
    "sugg.saveRule": "Save as a project rule?",
    "dod.ready": "Ready",
    "dod.title": "Definition of Done",
    "dod.applied": "Applied",
    "dod.appliedTitle": "A change has been applied to the file",
    "dod.gate": "Gate",
    "dod.gateTitle": "Local validation (lint/types) of the last applied change",
    "dod.run": "Runs",
    "dod.runTitle": "Run the last applied file",
    "dod.tests": "Tests",
    "dod.testsTitle": "Run the test suite",
    "dod.review": "Review",
    "dod.reviewTitle": "Review the changes (in-network AI)",
  },
};
