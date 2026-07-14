import React, { useEffect, useRef, useState } from "react";
import { Icon } from "../icons";
import { getLocale, t, type MessageKey } from "../i18n";
import { atMentionToken, filterMentions, mentionInsertText, replaceMention, splitMentionLabel } from "../mentions";
import type { Action, MessageVM, PartialFileBlock, ProfileView, ProposalVM, RunResultData, UIState } from "../state";
import { parsePartialFileBlocks, stripFileBlocksFromText } from "../state";
import { post } from "../vscode";
import type { WorkspaceEntry } from "../../../src/shared/protocol";
import {
  CharterKey,
  isRenderablePath,
  PROJECT_ARCHITECTURES,
  PROJECT_LANGUAGES,
  PROJECT_FRAMEWORKS,
  PROJECT_UIS,
  ProjectArchitecture,
  ProjectFramework,
  ProjectLanguage,
  ProjectUI,
} from "../../../src/shared/protocol";
import type { BlueprintFileView, ProjectFileStatus, RagChunkView, RoleCard, SkillInspectView } from "../../../src/shared/protocol";
import { pytestOutcome, TestOutcome } from "../../../src/util/testOutcome";
import { classifyProjectIntent } from "../../../src/util/projectIntent";
import { buildDbtTestsRequest, buildDiagramRequest, buildProjectSummaryRequest, buildSqlTranslateRequest, commandHint, commandLabel, exactSlashCommand, matchesFullForm, matchSlashCommands, normalizeSlash, renderHelp, renderTokensReport, SLASH_COMMANDS, slashWithArgs, SQL_DIALECTS, type SlashCommand } from "../commands";
import { DiffView } from "./DiffView";
import { Markdown } from "./Markdown";
import { DEFAULT_REASONING_EFFORT, effectiveTimeoutSeconds, MAX_OUTPUT_PRESETS, maxOutputLabel, REASONING_EFFORTS, type ReasoningEffort } from "../../../src/shared/protocol";

// Mapas de rótulo exibido → CHAVES do catálogo, resolvidas no render via t(). Não usar t() em const
// módulo-nível: os módulos avaliam ANTES do initLocale() do main.tsx e o texto congelaria em pt-BR.
const EFFORT_KEY: Record<ReasoningEffort, MessageKey> = { low: "effort.low", medium: "effort.medium", high: "effort.high" };
const effortLabel = (e: ReasoningEffort): string => t(EFFORT_KEY[e]);
// Idioma de SAÍDA da geração (forge.outputLanguage). Ciclo no rodapé: auto → pt-BR → en. "auto" segue o
// locale da UI; os rótulos pt-BR/en são nomes próprios (idênticos em todos os locales), só "auto" é chave.
type OutputLang = "auto" | "pt-BR" | "en";
const OUTPUT_LANGS: OutputLang[] = ["auto", "pt-BR", "en"];
const outputLangLabel = (l: OutputLang): string => (l === "auto" ? t("lang.auto") : l === "pt-BR" ? "PT-BR" : "EN");
// Nomes próprios (Python/TypeScript/Java/Go) — idênticos em todos os locales, sem chave.
const PROJ_LANG_LABEL: Record<ProjectLanguage, string> = { python: "Python", typescript: "TypeScript", java: "Java", go: "Go" };
const PROJ_ARCH_KEY: Record<ProjectArchitecture, MessageKey> = {
  hexagonal: "proj.arch.hexagonal",
  clean: "proj.arch.clean",
  layered: "proj.arch.layered",
  mvc: "proj.arch.mvc",
};
const archLabel = (a: ProjectArchitecture): string => t(PROJ_ARCH_KEY[a]);
const PROJ_UI_KEY: Record<ProjectUI, MessageKey> = {
  auto: "proj.ui.auto",
  none: "proj.ui.none",
  "template-engine": "proj.ui.templateEngine",
  "spa-react": "proj.ui.spaReact",
  streamlit: "proj.ui.streamlit",
};
const uiLabel = (u: ProjectUI): string => t(PROJ_UI_KEY[u]);
const PROJ_FW_KEY: Record<ProjectFramework, MessageKey> = {
  auto: "proj.fw.auto",
  fastapi: "proj.fw.fastapi",
  flask: "proj.fw.flask",
  litestar: "proj.fw.litestar",
};
const fwLabel = (f: ProjectFramework): string => t(PROJ_FW_KEY[f]);

// Label EXIBIDO de um comando da paleta pelo id — para os ecos "[/cmd] …" na bolha do usuário
// (um usuário en vê o eco com o label que a paleta mostra: [/connections], não [/conexoes]).
const cmdLabelById = (id: string): string => {
  const c = SLASH_COMMANDS.find((x) => x.id === id);
  return c ? commandLabel(c) : `/${id}`;
};

export function DevPanel({ state, dispatch }: { state: UIState; dispatch: React.Dispatch<Action> }): JSX.Element {
  const forge = state.forge!;
  const [input, setInput] = useState("");
  const [tdd, setTdd] = useState(false);
  const [projectMode, setProjectMode] = useState(false);
  const [language, setLanguage] = useState<ProjectLanguage>("python");
  const [architecture, setArchitecture] = useState<ProjectArchitecture>("hexagonal");
  // Camada de UI OPCIONAL do projeto (adendo do plano): "auto" = o modelo decide (default histórico).
  const [projUi, setProjUi] = useState<ProjectUI>("auto");
  // Framework web do projeto PYTHON (FastAPI/Flask/Litestar): "auto" = o modelo decide.
  const [projFw, setProjFw] = useState<ProjectFramework>("auto");
  const [attachMenu, setAttachMenu] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showCharter, setShowCharter] = useState(false);
  const [showInspect, setShowInspect] = useState(false);
  const [inspectSkill, setInspectSkill] = useState<string | null>(null); // deep-link do cartão de papel
  const bodyRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: "smooth" });
  }, [state.messages]);

  // Auto-desmarcar o Modo Projeto quando TODOS os arquivos foram aplicados (fim de fluxo): a próxima
  // mensagem volta a ser chat/diagnóstico. Reage ao seq monotônico do host (0 = nunca ocorreu).
  useEffect(() => {
    if (state.appliedAllAt) setProjectMode(false);
  }, [state.appliedAllAt]);

  // Comando de paleta ("FORGE: Inspecionar índice" / "Abrir perfil") pediu para abrir um modal — o
  // pedido chega no ESTADO (forge.uiPanel, com seq monotônico), robusto à corrida de montagem (cold
  // start / fim do onboarding). Abre UMA vez (compara o seq com o último visto) — replicando o clique do
  // slash — e confirma ao host via ui/panelConsumed, que limpa o pedido (não reabre em remount).
  const lastPanelSeq = useRef(0);
  useEffect(() => {
    const req = forge.uiPanel;
    if (!req || req.seq <= lastPanelSeq.current) return;
    lastPanelSeq.current = req.seq;
    if (req.panel === "inspect") {
      setShowInspect(true);
      post({ type: "inspect/open" });
    } else {
      dispatch({ kind: "clearProfile" });
      setShowProfile(true);
      post({ type: "profile/refresh" });
    }
    post({ type: "ui/panelConsumed" });
  }, [forge.uiPanel, dispatch]);

  const enabledSkills = forge.skills.filter((s) => s.enabled).length;
  const enabledMcp = forge.mcp.filter((m) => m.enabled);

  // Paleta "/": executa um comando do registry. A execução mora aqui (acesso a post/dispatch/estado
  // local); o registry (commands.ts) é declarativo/puro.
  const runSlash = (cmd: SlashCommand) => {
    setInput("");
    if (taRef.current) taRef.current.style.height = "auto";
    switch (cmd.id) {
      case "ajuda":
        dispatch({ kind: "pushLocal", text: renderHelp() });
        break;
      case "contexto":
        post({ type: "context/inspect" }); // o host responde context/report → cartão na thread
        break;
      case "tokens":
        dispatch({ kind: "pushLocal", text: renderTokensReport(state.usage) });
        break;
      case "limpar":
        dispatch({ kind: "newConversation" });
        post({ type: "chat/clear" }); // limpa o HOST também (histórico + anexos)
        break;
      case "ambiente":
        post({ type: "env/prepare" });
        break;
      case "testes":
        post({ type: "tests/run" });
        break;
      case "perfil":
        dispatch({ kind: "clearProfile" });
        setShowProfile(true);
        post({ type: "profile/refresh" });
        break;
      case "indice":
        setShowInspect(true);
        post({ type: "inspect/open" });
        break;
      case "projeto":
        // Espelha o pill: Projeto e TDD são mutuamente exclusivos.
        setProjectMode((v) => !v);
        setTdd(false);
        break;
      case "revisar":
        // Espelha o botão de revisão do cabeçalho.
        dispatch({ kind: "pushUser", text: t("echo.review") });
        post({ type: "review/changes" });
        break;
      case "resumir":
        post({ type: "chat/summarize" }); // o host responde chat/summarized → cartão na thread
        break;
      case "diagrama":
        runDiagram(""); // sem argumento = tema default (arquitetura do projeto)
        break;
      case "sumario":
        runSummary();
        break;
      case "impacto":
        runImpact(""); // sem argumento = modelo do arquivo ativo
        break;
      case "traduzir-sql":
        // dialeto é obrigatório — orienta sem apagar o rascunho
        dispatch({
          kind: "pushLocal",
          text: t("cmd.translateSql.prompt", { dialects: SQL_DIALECTS.map((d) => `\`${d}\``).join(", ") }),
        });
        break;
      case "testes-dbt":
        runDbtTests(""); // sem argumento = modelo do arquivo ativo
        break;
      case "conexoes":
        runData("conexoes");
        break;
      case "executar-sql":
        runData("executar-sql");
        break;
      case "schema-db":
        runData("schema-db");
        break;
      case "paridade":
        dispatch({ kind: "pushLocal", text: t("cmd.parity.usage") });
        break;
      case "custo":
        runData("custo");
        break;
      case "auditoria-pii":
        runData("auditoria-pii");
        break;
      case "arquivos":
        runWorkspace("files");
        break;
      case "buscar":
        runWorkspace("search", ""); // sem padrão → o host responde com o card de uso
        break;
      case "todos":
        runWorkspace("todos");
        break;
      case "git-status":
        runGit("status");
        break;
      case "git-diff":
        runGit("diff");
        break;
      case "git-log":
        runGit("log");
        break;
      case "git-commit":
        // mensagem é obrigatória — orienta sem apagar o rascunho
        dispatch({ kind: "pushLocal", text: t("cmd.gitCommit.prompt") });
        break;
    }
  };

  // Workspace GOVERNADO (resto do item 6): navegação/busca só-leitura — host executa determinístico
  // e responde com data/card (nenhum LLM no caminho). O eco usa o id do comando da PALETA (não o cmd
  // do protocolo) para o label sair no locale ativo.
  const WS_ECHO_ID: Record<"files" | "search" | "todos", string> = { files: "arquivos", search: "buscar", todos: "todos" };
  const runWorkspace = (cmd: "files" | "search" | "todos", args?: string) => {
    dispatch({ kind: "pushUser", text: `[${cmdLabelById(WS_ECHO_ID[cmd])}]${args?.trim() ? " " + args.trim() : ""}` });
    post({ type: "workspace/command", cmd, args: args?.trim() || undefined });
    setInput("");
    if (taRef.current) taRef.current.style.height = "auto";
  };

  // Git GOVERNADO (Fase 4): status/diff/log são leitura; commit é escrita (o host pede confirmação via
  // permission model). Host executa e responde com data/card — nenhum LLM no caminho.
  const runGit = (op: "status" | "diff" | "log" | "commit", args?: string) => {
    dispatch({ kind: "pushUser", text: `[${cmdLabelById(`git-${op}`)}]${args ? " " + args : ""}` });
    post({ type: "git/command", op, args });
    setInput("");
    if (taRef.current) taRef.current.style.height = "auto";
  };

  // /diagrama [tema]: geração normal com prompt craftado — o diagrama nasce como PROPOSTA de arquivo
  // versionável (docs/diagramas/*.md), reusando todo o pipeline de propostas/aplicação/continuação.
  const runDiagram = (theme: string) => {
    dispatch({ kind: "pushUser", text: `[${cmdLabelById("diagrama")}] ${theme.trim() || t("echo.diagramDefault")}` });
    post({ type: "chat/send", text: buildDiagramRequest(theme) });
    setInput("");
    if (taRef.current) taRef.current.style.height = "auto";
  };

  // /sumário projeto: documentação funcional padrão de mercado como PROPOSTA versionável
  // (docs/SUMARIO_FUNCIONAL.md) — geração normal com prompt craftado, zero protocolo novo.
  const runSummary = () => {
    dispatch({ kind: "pushUser", text: `[${cmdLabelById("sumario")}] ${t("echo.summary")}` });
    post({ type: "chat/send", text: buildProjectSummaryRequest() });
    setInput("");
    if (taRef.current) taRef.current.style.height = "auto";
  };

  // /impacto [modelo]: raio de explosão determinístico (lineage do manifest dbt) — computado pelo HOST,
  // sem LLM; a resposta volta como impact/report → cartão na thread (padrão do /contexto).
  const runImpact = (target: string) => {
    dispatch({ kind: "pushUser", text: `[${cmdLabelById("impacto")}] ${target.trim() || t("echo.activeFileModel")}` });
    post({ type: "impact/request", target: target.trim() || undefined });
    setInput("");
    if (taRef.current) taRef.current.style.height = "auto";
  };

  // /traduzir-sql <dialeto>: tradução com preservação semântica como PROPOSTA .sql — o motor SQL
  // determinístico do host valida o resultado (parse/anti-padrões/schema) como qualquer proposta.
  const runTranslate = (dialect: string) => {
    const d = dialect.trim().toLowerCase();
    if (!SQL_DIALECTS.includes(d)) {
      dispatch({
        kind: "pushLocal",
        text: t("cmd.dialectUnknown", { dialect: dialect.trim(), dialects: SQL_DIALECTS.map((x) => `\`${x}\``).join(", ") }),
      });
      return;
    }
    dispatch({ kind: "pushUser", text: `[${cmdLabelById("traduzir-sql")}] ${t("echo.translate", { dialect: d })}` });
    post({ type: "chat/send", text: buildSqlTranslateRequest(d) });
    setInput("");
    if (taRef.current) taRef.current.style.height = "auto";
  };

  // Comandos de DADOS (Ondas 3/4): host executa (conexões/SQL/schema/paridade/custo/PII) e responde
  // com data/card — nenhum LLM no caminho; governança do motor no host.
  const runData = (cmd: "conexoes" | "executar-sql" | "schema-db" | "paridade" | "custo" | "auditoria-pii", args?: string) => {
    dispatch({ kind: "pushUser", text: `[${cmdLabelById(cmd)}]${args ? " " + args : ""}` });
    post({ type: "data/command", cmd, args });
    setInput("");
    if (taRef.current) taRef.current.style.height = "auto";
  };

  // /testes-dbt [modelo]: schema.yml com a taxonomia coluna→teste, ancorado no schema REAL que o host
  // injeta no contexto (manifest dbt) — proposta versionável, mesmo pipeline de aplicação.
  const runDbtTests = (model: string) => {
    dispatch({ kind: "pushUser", text: `[${cmdLabelById("testes-dbt")}] ${model.trim() || t("echo.activeFileModel")}` });
    post({ type: "chat/send", text: buildDbtTestsRequest(model) });
    setInput("");
    if (taRef.current) taRef.current.style.height = "auto";
  };

  const send = () => {
    const text = input.trim();
    if (!text || state.busy) return;
    // Paleta "/": SÓ o comando exato e nu executa. Typo de um token orienta SEM apagar o rascunho;
    // "/algo com cauda" é mensagem legítima do dev e segue para o modelo (nunca sequestrar) —
    // EXCETO comandos declarados acceptsArgs (a cauda é o argumento esperado: "/diagrama fluxo X").
    if (text.startsWith("/") && !/\s/.test(text)) {
      const cmd = exactSlashCommand(text);
      if (cmd) {
        runSlash(cmd);
      } else {
        dispatch({ kind: "pushLocal", text: t("cmd.unknown", { text }) });
      }
      return;
    }
    const withArgs = slashWithArgs(text);
    if (withArgs) {
      if (withArgs.cmd.id === "diagrama") {
        runDiagram(withArgs.args); // a cauda É o argumento (tema)
        return;
      }
      if (withArgs.cmd.id === "sumario" && matchesFullForm(withArgs.cmd, withArgs.args)) {
        runSummary(); // a forma completa ("/sumário projeto" ~ "/summary project") executa em qualquer locale
        return;
      }
      // /impacto e /testes-dbt: a cauda só é argumento quando é UM token (nome de modelo válido);
      // cauda multi-palavra ("/impacto o que quebra se eu mudar X?") é mensagem do dev e segue ao
      // modelo — anti-sequestro (achado da revisão adversarial).
      if (withArgs.cmd.id === "impacto" && /^[\w.-]+$/.test(withArgs.args)) {
        runImpact(withArgs.args);
        return;
      }
      if (withArgs.cmd.id === "traduzir-sql") {
        runTranslate(withArgs.args); // a cauda É o argumento (dialeto alvo); inválido orienta sem apagar
        return;
      }
      if (withArgs.cmd.id === "testes-dbt" && /^[\w.-]+$/.test(withArgs.args)) {
        runDbtTests(withArgs.args);
        return;
      }
      // dados: conexão é token único; /paridade aceita exatamente dois tokens (tabelas, com : opcional)
      if ((withArgs.cmd.id === "executar-sql" || withArgs.cmd.id === "schema-db" || withArgs.cmd.id === "custo") && /^[\w.-]+$/.test(withArgs.args)) {
        runData(withArgs.cmd.id, withArgs.args);
        return;
      }
      if (withArgs.cmd.id === "paridade" && /^[\w.:-]+\s+[\w.:-]+$/.test(withArgs.args.trim())) {
        runData("paridade", withArgs.args.trim());
        return;
      }
      // /arquivos <pasta>: a cauda é o filtro quando é UM token com cara de caminho; frase segue ao
      // modelo (anti-sequestro). O gate usa \p{L}\p{N} (não \w, que é ASCII e rejeitaria pastas
      // acentuadas — "relatórios", "configuração" — num produto pt-BR-first; achado da revisão).
      // /buscar <regex>: a cauda É o padrão (texto livre — regex tem espaço e metacaracteres, como o
      // tema do /diagrama).
      if (withArgs.cmd.id === "arquivos" && /^[\p{L}\p{N}._/\\-]+$/u.test(withArgs.args)) {
        runWorkspace("files", withArgs.args);
        return;
      }
      if (withArgs.cmd.id === "buscar") {
        runWorkspace("search", withArgs.args);
        return;
      }
      // /git-commit "mensagem": a cauda É a mensagem (qualquer texto). Aspas opcionais — removidas.
      if (withArgs.cmd.id === "git-commit") {
        runGit("commit", withArgs.args.trim().replace(/^["']|["']$/g, ""));
        return;
      }
      // Cauda que NÃO é o argumento esperado ("/sumario o que ficou pendente?") é mensagem do dev —
      // cai no fluxo normal em vez de disparar a geração e descartar o texto (anti-sequestro).
    }
    // No Modo Projeto, só um PEDIDO de gerar abre o Blueprint. Pergunta/diagnóstico (ex.: logs colados
    // + "o que aconteceu?") é respondido no chat normal — sem sequestrar a mensagem para o Blueprint.
    if (projectMode && classifyProjectIntent(text) === "generate") {
      // Fase F: planeja um BLUEPRINT aprovável antes de gerar código. Guarda o brief (para o "Tentar
      // de novo" caso o planejamento falhe). Streamlit é Python-only — o select filtra, e aqui o
      // guard defensivo garante ("auto") caso a linguagem mude depois da escolha.
      const ui = projUi === "streamlit" && language !== "python" ? "auto" : projUi;
      const framework = language === "python" ? projFw : "auto"; // framework é Python-only (defensivo)
      const uiTag = ui !== "auto" ? `/${uiLabel(ui)}` : "";
      const fwTag = framework !== "auto" ? `/${fwLabel(framework)}` : "";
      dispatch({ kind: "pushUser", text: `[${t("comp.project")} · ${PROJ_LANG_LABEL[language]}/${archLabel(architecture)}${fwTag}${uiTag}] ${text}` });
      dispatch({ kind: "project/planning", brief: { text, language, architecture, ui, framework } });
      post({ type: "project/blueprint", text, language, architecture, ui, framework });
    } else {
      dispatch({ kind: "pushUser", text: tdd ? `[TDD] ${text}` : text });
      post({ type: "chat/send", text, tdd });
    }
    setInput("");
    if (taRef.current) taRef.current.style.height = "auto";
  };

  // Autocomplete da paleta: aberto enquanto o texto começa com "/" (um token só), há matches e o
  // dev não o dispensou (Esc/blur). Texto com cauda é mensagem normal — popover não atrapalha.
  const [slashDismissed, setSlashDismissed] = useState(false);
  const slashMatches = input.startsWith("/") && !/\s/.test(input.trim()) ? matchSlashCommands(input.trim()) : [];
  const slashOpen = slashMatches.length > 0 && !state.busy && !slashDismissed;
  const [slashSel, setSlashSel] = useState(0);
  useEffect(() => {
    setSlashSel(0);
    setSlashDismissed(false); // digitou → o popover volta (o dismiss vale só para o estado atual)
  }, [input]);

  // Menção "@": picker inline de arquivos/pastas do workspace (molde da paleta "/", mas CIENTE do caret — o
  // "@" pode estar no meio da mensagem). O catálogo é pedido ao host na 1ª menção e cacheado no estado; o
  // filtro roda localmente (sem round-trip por tecla). Selecionar ANEXA o arquivo (chip) e limpa o @token.
  const [caret, setCaret] = useState(0);
  const [atSel, setAtSel] = useState(0);
  const [atDismissed, setAtDismissed] = useState(false);
  const lastWsFetch = useRef(0);
  const mentionTok = atMentionToken(input, caret);
  const mentionItems = mentionTok ? filterMentions(state.workspaceFiles, mentionTok.query, 12) : [];
  const atOpen = !!mentionTok && !state.busy && !atDismissed && mentionItems.length > 0;
  // Refetch do catálogo ao ABRIR o picker (debounce ~2s): arquivos criados/movidos/copiados aparecem sem
  // recarregar a webview. Antes era buscado UMA vez e cacheado p/ sempre (once-guard) → staleness. O cache
  // segue servindo o filtro instantâneo enquanto se digita; só re-varre na abertura (e no máx. 1×/2s).
  useEffect(() => {
    if (!mentionTok) return;
    const now = Date.now();
    if (now - lastWsFetch.current < 2000) return;
    lastWsFetch.current = now;
    post({ type: "context/listWorkspaceFiles" });
  }, [!!mentionTok]);
  useEffect(() => {
    setAtSel(0);
    setAtDismissed(false); // digitou/moveu o caret → o popover volta
  }, [input, caret]);

  const chooseMention = (entry: WorkspaceEntry) => {
    post({ type: "context/addWorkspaceFile", path: entry.path, kind: entry.kind });
    if (mentionTok) {
      // Insere a referência inline `@caminho[/] ` no lugar do token (antes era apagado → a citação sumia do
      // prompt). O anexo carrega o conteúdo; a referência deixa a frase coerente e o subdir inequívoco.
      const { text, caret: nc } = replaceMention(input, mentionTok, mentionInsertText(entry));
      setInput(text);
      requestAnimationFrame(() => {
        const ta = taRef.current;
        if (ta) {
          ta.selectionStart = ta.selectionEnd = nc;
          ta.focus();
        }
        setCaret(nc);
      });
    }
    setAtDismissed(true);
  };

  // Submissão unificada: Enter e o botão Enviar fazem O MESMO — com popover aberto, executa o item
  // selecionado; senão, send(). Divergir os dois confundia (Enter rodava /limpar, botão dava "typo").
  const submit = () => {
    if (atOpen) {
      chooseMention(mentionItems[Math.min(atSel, mentionItems.length - 1)]);
      return;
    }
    if (slashOpen) {
      runSlash(slashMatches[Math.min(slashSel, slashMatches.length - 1)]);
      return;
    }
    send();
  };

  const onKey = (e: React.KeyboardEvent) => {
    // A menção "@" tem PRECEDÊNCIA sobre a paleta "/" (mutuamente exclusivas na prática, mas por garantia).
    if (atOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setAtSel((i) => (i + 1) % mentionItems.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setAtSel((i) => (i - 1 + mentionItems.length) % mentionItems.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        chooseMention(mentionItems[Math.min(atSel, mentionItems.length - 1)]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setAtDismissed(true); // fecha SÓ o popover — o rascunho fica intacto
        return;
      }
    }
    if (slashOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashSel((i) => (i + 1) % slashMatches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashSel((i) => (i - 1 + slashMatches.length) % slashMatches.length);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        runSlash(slashMatches[Math.min(slashSel, slashMatches.length - 1)]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashDismissed(true); // fecha SÓ o popover — o rascunho fica intacto
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  // Colar um PRINT no chat: intercepta a imagem do clipboard e a envia ao host para OCR (o texto vira
  // anexo). Sem imagem, deixa o paste de texto normal seguir. Corrige o "colar não funciona" (ponto 6).
  const onPaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === "file" && it.type.startsWith("image/")) {
        const file = it.getAsFile();
        if (!file || file.size > 8 * 1024 * 1024) continue; // muito grande (>8 MB) → ignora este item
        e.preventDefault(); // não cola o binário/nome como texto
        const reader = new FileReader();
        reader.onload = () => {
          if (typeof reader.result === "string") post({ type: "context/addImage", dataUrl: reader.result });
        };
        reader.readAsDataURL(file);
        return;
      }
    }
  };

  return (
    <div className="app">
      {/* Cabeçalho */}
      <div className="hdr">
        <div className="hdr-row">
          <Icon name="flame" size={16} color="#e0863c" />
          <span className="hdr-title">FORGE</span>
          <span className="lic-pill">
            <span className="dot" style={{ background: "#3fb950" }} /> {t("hdr.licenseActive")}
          </span>
          <div className="spacer" />
          {forge.observability.traceActive && (
            <span
              className="chip"
              style={{ color: "#6f8fb0" }}
              title={t("hdr.traceTitle", { user: forge.identity.email ?? forge.observability.login })}
            >
              <Icon name="activity" size={13} /> trace
            </span>
          )}
          <button
            className="icon-btn"
            title={t("hdr.review")}
            onClick={() => {
              dispatch({ kind: "pushUser", text: t("echo.review") });
              post({ type: "review/changes" });
            }}
          >
            <Icon name="list-check" size={15} />
          </button>
          <button
            className="icon-btn"
            title={t("hdr.newChat")}
            onClick={() => {
              // Mesmo efeito do /limpar: sem o chat/clear o host seguia reenviando o histórico
              // antigo — a conversa "nova" era silenciosamente contaminada (bugfix).
              dispatch({ kind: "newConversation" });
              post({ type: "chat/clear" });
            }}
          >
            <Icon name="history" size={15} />
          </button>
          <button className="icon-btn" title={t("hdr.settings")} onClick={() => post({ type: "provider/openSettings" })}>
            <Icon name="settings" size={15} />
          </button>
        </div>
        <div className="model-bar" onClick={() => post({ type: "provider/openSettings" })}>
          <span className="left">
            <Icon name="server-bolt" size={14} color="#e0863c" />
            {forge.provider.label ?? `${forge.provider.type} · ${forge.provider.modelId}`}
          </span>
          <Icon name="chevron-down" size={13} color="#8b8b8b" />
        </div>
      </div>

      {/* Corpo */}
      <div className="body" ref={bodyRef}>
        <div className="msgs">
          {state.messages.length === 0 && (
            <div className="empty">
              <Icon name="flame" size={30} color="#3a3a3a" />
              <div style={{ marginTop: 12, color: "#9a9a9a", fontSize: 13 }}>{t("empty.ready")}</div>
              <div style={{ marginTop: 6 }}>{t("empty.hint")}</div>
              <div style={{ marginTop: 14, fontSize: 11, color: "#6f6f6f" }}>
                {t("empty.counts", { skills: enabledSkills, mcp: enabledMcp.length })}
              </div>
            </div>
          )}
          {state.messages.map((m) =>
            m.role === "user" ? <UserBubble key={m.id} m={m} /> : <AssistantBlock key={m.id} m={m} dispatch={dispatch} />
          )}
          {state.runs.map((r) => (
            <RunCard key={r.id} run={r} dispatch={dispatch} onDismiss={() => dispatch({ kind: "run/dismiss", id: r.id })} />
          ))}
        </div>

        {state.messages.length > 0 && (
          <div className="ctx">
            <div className="ctx-row">
              <Icon name="paperclip" size={13} /> {t("ctxbar.context", { skills: enabledSkills })}
            </div>
            {enabledMcp.length > 0 && (
              <div className="ctx-row">
                <Icon name="plug" size={13} color="#8aa0b8" /> MCP: {enabledMcp.map((m) => m.id).join(", ")}
                <span className="chip" style={{ color: "#6f8fb0" }}>
                  <Icon name="network" size={12} /> {t("ob.internalNetwork")}
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Definição de Pronto (DoD) */}
      <DodBar state={state} dispatch={dispatch} />

      {/* Compositor */}
      <div className="composer">
        {attachMenu && (
          <>
            <div className="attach-backdrop" onClick={() => setAttachMenu(false)} />
            <div className="attach-menu">
              <button onClick={() => { setAttachMenu(false); post({ type: "context/addSelection" }); }}>
                <Icon name="code" size={14} /> {t("att.editorSelection")}
              </button>
              <button onClick={() => { setAttachMenu(false); post({ type: "context/addTerminalSelection" }); }}>
                <Icon name="terminal" size={14} /> {t("att.terminalSelection")}
              </button>
              <button onClick={() => { setAttachMenu(false); post({ type: "context/pickWorkspaceFile" }); }}>
                <Icon name="paperclip" size={14} /> {t("att.workspaceFile")}
              </button>
              <button onClick={() => { setAttachMenu(false); post({ type: "context/pickLocalFile" }); }}>
                <Icon name="arrow-up" size={14} /> {t("att.upload")}
              </button>
              {forge.search.enabled ? (
                <button onClick={() => { setAttachMenu(false); post({ type: "context/search" }); }}>
                  <Icon name="search" size={14} color="#86c98e" /> {forge.search.label}
                </button>
              ) : (
                <button className="disabled" onClick={() => { setAttachMenu(false); post({ type: "context/webInfo" }); }}>
                  <Icon name="network" size={14} /> {t("att.webBlocked")}
                </button>
              )}
            </div>
          </>
        )}
        <ProfileSuggestion messages={state.messages} />
        {state.roleCard && (
          <RoleCardView
            card={state.roleCard}
            onDismiss={() => dispatch({ kind: "roleCard/dismiss" })}
            onOpenSkill={(name) => {
              setInspectSkill(name); // deep-link: o Índice abre já no SKILL.md clicado
              setShowInspect(true);
              post({ type: "inspect/open" });
            }}
          />
        )}
        <div className="composer-box">
          {atOpen && (
            // Menção "@": popover de arquivos/pastas do workspace (↑↓ navega, Enter/Tab anexa, Esc fecha).
            <div className="slash-pop mention-pop">
              {mentionItems.map((entry, i) => {
                // basename FORTE + prefixo de diretório ESMAECIDO — subdir legível e inequívoco (o basename
                // sozinho é ambíguo quando há homônimos em pastas diferentes).
                const { dir, base } = splitMentionLabel(entry.path);
                return (
                  <div
                    key={entry.path}
                    className={`slash-item${i === atSel ? " sel" : ""}`}
                    onMouseEnter={() => setAtSel(i)}
                    onMouseDown={(e) => {
                      e.preventDefault(); // não rouba o foco do textarea
                      chooseMention(entry);
                    }}
                  >
                    <Icon name={entry.kind === "folder" ? "folder" : "file"} size={13} />
                    <span className="slash-label">{base}</span>
                    {dir && <span className="slash-hint">{dir}</span>}
                  </div>
                );
              })}
            </div>
          )}
          {slashOpen && (
            // Paleta "/": popover ancorado acima do composer (↑↓ navega, Enter/Tab executa, Esc fecha).
            <div className="slash-pop">
              {slashMatches.map((c, i) => (
                <div
                  key={c.id}
                  className={`slash-item${i === slashSel ? " sel" : ""}`}
                  onMouseEnter={() => setSlashSel(i)}
                  onMouseDown={(e) => {
                    e.preventDefault(); // não rouba o foco do textarea
                    runSlash(c);
                  }}
                >
                  <Icon name={c.icon} size={13} />
                  <span className="slash-label">{commandLabel(c)}</span>
                  <span className="slash-hint">{commandHint(c)}</span>
                </div>
              ))}
            </div>
          )}
          {state.attachments.length > 0 && (
            <div className="attach-chips">
              {state.attachments.map((a) => (
                <span key={a.id} className="attach-chip" title={`${a.label} · ${a.bytes} chars`}>
                  <Icon
                    name={a.kind === "upload" ? "arrow-up" : a.kind === "selection" ? "code" : a.kind === "search" ? "search" : "paperclip"}
                    size={12}
                  />
                  {a.label}
                  <span
                    style={{ cursor: "pointer", display: "inline-flex" }}
                    onClick={() => post({ type: "context/removeAttachment", id: a.id })}
                  >
                    <Icon name="x" size={12} />
                  </span>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={taRef}
            placeholder={t("comp.placeholder")}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setCaret(e.target.selectionStart ?? 0); // rastreia o caret p/ a menção "@" (ciente da posição)
              e.target.style.height = "auto";
              e.target.style.height = Math.min(e.target.scrollHeight, 140) + "px";
            }}
            onKeyUp={(e) => setCaret(e.currentTarget.selectionStart ?? 0)} // setas/navegação movem o caret
            onClick={(e) => setCaret(e.currentTarget.selectionStart ?? 0)} // clique reposiciona o caret
            onKeyDown={onKey}
            onPaste={onPaste}
            onBlur={() => {
              setSlashDismissed(true);
              setAtDismissed(true);
            }} // clique fora fecha os popovers (itens usam mouseDown+preventDefault e não disparam blur)
            onFocus={() => {
              setSlashDismissed(false);
              setAtDismissed(false);
            }}
            rows={1}
          />
          <div className="composer-tools">
            <span className="pill" title={t("att.title")} onClick={() => setAttachMenu((v) => !v)}>
              <Icon name="paperclip" size={15} />
            </span>
            <span
              className="pill"
              title={t("comp.projectTitle")}
              onClick={() => {
                setProjectMode((v) => !v);
                setTdd(false);
              }}
              style={{ color: projectMode ? "#e0863c" : undefined, fontWeight: projectMode ? 500 : undefined }}
            >
              <Icon name={projectMode ? "circle-check" : "circle"} size={14} color={projectMode ? "#e0863c" : undefined} /> {t("comp.project")}
            </span>
            <span
              className="pill"
              title={t("comp.tddTitle")}
              onClick={() => {
                setTdd((v) => !v);
                setProjectMode(false);
              }}
              style={{ color: tdd ? "#e0863c" : undefined, fontWeight: tdd ? 500 : undefined }}
            >
              <Icon name={tdd ? "circle-check" : "circle"} size={14} color={tdd ? "#e0863c" : undefined} /> TDD
            </span>
            {projectMode && (
              <>
                <select
                  className="proj-select"
                  title={t("comp.langTitle")}
                  value={language}
                  onChange={(e) => {
                    const l = e.target.value as ProjectLanguage;
                    setLanguage(l);
                    // Streamlit e o framework Python são Python-only: sem o reset o select
                    // controlado fica com value ÓRFÃO (dropdown em branco).
                    if (l !== "python" && projUi === "streamlit") setProjUi("auto");
                    if (l !== "python") setProjFw("auto");
                  }}
                >
                  {PROJECT_LANGUAGES.map((l) => (
                    <option key={l} value={l}>
                      {PROJ_LANG_LABEL[l]}
                    </option>
                  ))}
                </select>
                <select className="proj-select" title={t("comp.archTitle")} value={architecture} onChange={(e) => setArchitecture(e.target.value as ProjectArchitecture)}>
                  {PROJECT_ARCHITECTURES.map((a) => (
                    <option key={a} value={a}>
                      {archLabel(a)}
                    </option>
                  ))}
                </select>
                <select
                  className="proj-select"
                  title={t("comp.uiTitle")}
                  value={projUi}
                  onChange={(e) => setProjUi(e.target.value as ProjectUI)}
                >
                  {PROJECT_UIS.filter((u) => u !== "streamlit" || language === "python").map((u) => (
                    <option key={u} value={u}>
                      {uiLabel(u)}
                    </option>
                  ))}
                </select>
                {language === "python" && (
                  <select
                    className="proj-select"
                    title={t("comp.fwTitle")}
                    value={projFw}
                    onChange={(e) => setProjFw(e.target.value as ProjectFramework)}
                  >
                    {PROJECT_FRAMEWORKS.map((f) => (
                      <option key={f} value={f}>
                        {fwLabel(f)}
                      </option>
                    ))}
                  </select>
                )}
              </>
            )}
            {/* Testes/Ambiente/Índice/Perfil/Papel saíram da barra (composer enxuto): acessíveis pela
                paleta de comandos ("FORGE: …") e pelos slash /testes /ambiente /indice /perfil. */}
            <span className="pill" title={forge.provider.modelId}>
              <Icon name="cpu" size={14} /> {forge.provider.modelId}
            </span>
            <div className="spacer" />
            {state.busy ? (
              <button
                className="send-btn"
                title={t("comp.stop")}
                style={{ background: "#3a3a3a", color: "#ddd" }}
                onClick={() => {
                  const last = [...state.messages].reverse().find((x) => x.role === "assistant" && x.streaming);
                  if (last) post({ type: "chat/abort", taskId: last.id });
                }}
              >
                <Icon name="x" size={15} />
              </button>
            ) : (
              <button className="send-btn" title={t("comp.send")} onClick={submit} disabled={!input.trim()}>
                <Icon name="arrow-up" size={15} />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Barra de status */}
      <div className="statusbar">
        {/* O rótulo do provedor ("HubGPU/compat · modelo") saiu do rodapé a pedido; o modelo atual
            continua visível no pill do composer. */}
        <div className="sb-item" style={{ color: "#7bbf6a" }}>
          <Icon name="shield-check" size={13} /> {t("ob.step.license")} ✓
        </div>
        {forge.observability.traceActive && (
          <div className="sb-item" style={{ color: "#7bbf6a" }} title={t("sb.traceTitle", { user: forge.identity.email ?? forge.observability.login })}>
            <Icon name="activity" size={13} /> trace ✓
          </div>
        )}
        {forge.network.internalOnly && (
          <div className="sb-item" style={{ color: "#8aa0b8" }}>
            <Icon name="network" size={13} /> {t("ob.internalNetwork")}
          </div>
        )}
        {forge.rag.enabled && (
          <div
            className="sb-item"
            style={{ color: !forge.rag.ready ? "#9a9a9a" : forge.rag.mode === "embeddings" ? "#7bbf6a" : "#b0a070" }}
            title={
              !forge.rag.ready
                ? t("sb.ragIndexingTitle")
                : forge.rag.mode === "embeddings"
                ? t("sb.ragSemanticTitle", { model: forge.rag.embeddingModel, files: forge.rag.files })
                : t("sb.ragLexicalTitle", { files: forge.rag.files })
            }
          >
            <Icon name="database" size={13} className={!forge.rag.ready ? "spin" : ""} />
            {!forge.rag.ready ? t("sb.ragIndexing") : `RAG ${forge.rag.mode === "embeddings" ? "embeddings" : "lexical"} · ${forge.rag.chunks}`}
          </div>
        )}
        <div className="spacer" />
        {forge.provider.supportsReasoningEffort && (
          <button
            className="sb-item sb-btn"
            title={t("sb.effortTitle")}
            onClick={() => {
              const cur = forge.provider.reasoningEffort ?? DEFAULT_REASONING_EFFORT;
              const next = REASONING_EFFORTS[(REASONING_EFFORTS.indexOf(cur) + 1) % REASONING_EFFORTS.length];
              post({ type: "provider/setEffort", effort: next });
            }}
          >
            <Icon name="cpu" size={13} /> {t("sb.effort", { level: effortLabel(forge.provider.reasoningEffort ?? DEFAULT_REASONING_EFFORT) })}
          </button>
        )}
        {forge.provider.configured && (
          <button
            className="sb-item sb-btn"
            title={t("sb.maxOutTitle")}
            onClick={() => {
              const cur = forge.provider.maxOutput ?? 0;
              const idx = MAX_OUTPUT_PRESETS.indexOf(cur);
              const next = MAX_OUTPUT_PRESETS[(idx < 0 ? 0 : idx + 1) % MAX_OUTPUT_PRESETS.length];
              post({ type: "provider/setMaxOutput", maxTokens: next });
            }}
          >
            <Icon name="activity" size={13} /> {t("sb.maxOut", { label: maxOutputLabel(forge.provider.maxOutput) })}
          </button>
        )}
        <button
          className="sb-item sb-btn"
          title={t("sb.langTitle")}
          onClick={() => {
            const cur = (forge.provider.outputLanguage ?? "auto") as OutputLang;
            const next = OUTPUT_LANGS[(OUTPUT_LANGS.indexOf(cur) + 1) % OUTPUT_LANGS.length];
            post({ type: "provider/setOutputLanguage", lang: next });
          }}
        >
          <Icon name="globe" size={13} /> {t("sb.lang", { lang: outputLangLabel((forge.provider.outputLanguage ?? "auto") as OutputLang) })}
        </button>
        <div className="sb-item" style={{ color: "#9a9a9a" }}>
          timeout {forge.provider.timeoutSeconds ?? effectiveTimeoutSeconds(forge.provider.reasoningEffort)}s
        </div>
        {state.usage && (
          <div
            className="sb-item"
            style={{ color: "#9a9a9a" }}
            title={t("sb.usageTitle", { sessionIn: state.usage.sessionIn, sessionOut: state.usage.sessionOut, lastIn: state.usage.lastIn, lastOut: state.usage.lastOut })}
          >
            <Icon name="activity" size={12} /> {fmtTokens(state.usage.sessionIn)}→{fmtTokens(state.usage.sessionOut)}
          </div>
        )}
      </div>

      {showProfile && (
        <ProfilePanel
          profile={state.profile}
          onClose={() => setShowProfile(false)}
          onWizard={() => {
            setShowProfile(false);
            post({ type: "charter/open" });
            setShowCharter(true);
          }}
        />
      )}
      {showCharter && <CharterWizard state={state} dispatch={dispatch} onClose={() => setShowCharter(false)} />}
      {showInspect && (
        <InspectPanel
          state={state}
          initialSkill={inspectSkill}
          onClose={() => {
            setShowInspect(false);
            setInspectSkill(null); // o deep-link vale só para a abertura que o pediu
          }}
        />
      )}
      {state.project && <ProjectPlanPanel state={state} dispatch={dispatch} />}
    </div>
  );
}

// Fase F: painel do blueprint (FileTree aprovável). Planeja → aprova → gera → aplica tudo.
const STATUS_DOT: Record<ProjectFileStatus, string> = {
  pending: "#5a5a5a",
  generating: "#e0863c",
  complete: "#86c98e",
  applied: "#4ec9b0",
  failed: "#d16969",
};
const STATUS_KEY: Record<ProjectFileStatus, MessageKey> = {
  pending: "plan.status.pending",
  generating: "plan.status.generating",
  complete: "plan.status.complete",
  applied: "plan.status.applied",
  failed: "plan.status.failed",
};
const statusLabel = (s: ProjectFileStatus): string => t(STATUS_KEY[s]);

function ProjectPlanPanel({ state, dispatch }: { state: UIState; dispatch: React.Dispatch<Action> }): JSX.Element {
  const proj = state.project!;
  const bp = proj.blueprint;
  const files: BlueprintFileView[] = bp?.files ?? [];
  const anyComplete = files.some((f) => f.status === "complete");
  // Gate workspace-wide: mapa path→erros para pintar os cartões reprovados (casa './x' com 'x'). Só os
  // arquivos com erro ATRIBUÍDO são pintados como bloqueados; projectErrors (falha sem atribuição) é um
  // aviso não-bloqueante mostrado no banner.
  const gate = proj.gate;
  const normPath = (p: string) => p.replace(/^[./\\]+/, "").replace(/\\/g, "/");
  const gateErrors = new Map<string, string[]>();
  for (const f of gate?.files ?? []) gateErrors.set(normPath(f.path), f.errors);
  const close = () => dispatch({ kind: "project/close" });
  // Reenvia o mesmo pedido (brief retido) após uma falha do planejamento — sem redigitar.
  const retry = () => {
    if (!proj.brief) return;
    dispatch({ kind: "project/planning", brief: proj.brief });
    post({ type: "project/blueprint", ...proj.brief });
  };
  return (
    <div className="modal-backdrop" onClick={proj.busy ? undefined : close}>
      <div className="modal plan-modal" onClick={(e) => e.stopPropagation()}>
        <div className="card-title">
          <Icon name="list-check" size={15} color="#e0863c" /> {t("plan.title")}
          {bp ? <span className="plan-sub">· {t("plan.files", { count: bp.files.length })}</span> : null}
          <div className="spacer" />
          {!proj.busy && (
            <span className="icon-btn" title={t("common.close")} onClick={close}>
              <Icon name="x" size={15} />
            </span>
          )}
        </div>

        {!bp ? (
          proj.error ? (
            // Falha do planejamento: modal FICA ABERTO com o erro real + "Tentar de novo" (não some).
            <>
              <div className="assistant-warning" style={{ marginTop: 4 }}>
                <Icon name="alert-triangle" size={14} /> {proj.error}
              </div>
              <div className="actions" style={{ marginTop: 12, justifyContent: "flex-end", gap: 8 }}>
                <button className="btn" onClick={close}>
                  {t("common.close")}
                </button>
                <button className="btn p" disabled={!proj.brief} onClick={retry}>
                  <Icon name="refresh" size={13} /> {t("plan.retry")}
                </button>
              </div>
            </>
          ) : (
            <div className="profile-empty">
              <Icon name="refresh" size={13} className="spin" /> {proj.planStep ?? t("plan.planning")}
            </div>
          )
        ) : (
          <>
            {proj.error && (
              // Falha na FASE DE GERAÇÃO (blueprint já existe): mostra o erro sem apagar a lista de arquivos.
              <div className="assistant-warning" style={{ marginTop: 4 }}>
                <Icon name="alert-triangle" size={14} /> {proj.error}
              </div>
            )}
            {proj.warning && (
              // Aviso não-fatal do planejamento (ex.: plano PARCIAL recuperado após truncamento por
              // limite de tokens) — dentro do modal, onde o dev decide entre aprovar ou tentar de novo.
              <div className="assistant-warning" style={{ marginTop: 4 }}>
                <Icon name="alert-triangle" size={14} /> {proj.warning}
              </div>
            )}
            <div className="plan-hint">{proj.done ? t("plan.hintDone") : t("plan.hintReview")}</div>
            {gate && (
              // Veredito do gate: reprovado (vermelho) · parcial/consultivo = coerência NÃO verificada
              // (âmbar, NÃO verde) · verde só quando compileall E mypy rodaram sem erro de contrato.
              <div
                className="assistant-warning"
                style={{ marginTop: 4, borderColor: gateErrors.size || gate.projectErrors.length || gate.dod?.length ? "#d16969" : gate.advisory || gate.partial ? "#d1a13a" : "#86c98e" }}
              >
                <Icon name={gateErrors.size || gate.projectErrors.length || gate.dod?.length || gate.advisory || gate.partial ? "alert-triangle" : "check"} size={14} /> {gate.summary}
                {gate.projectErrors.map((e, i) => (
                  <div key={i} className="mono" style={{ marginTop: 4, fontSize: 11, color: "#d16969", whiteSpace: "pre-wrap" }}>
                    {e}
                  </div>
                ))}
                {(gate.dod ?? []).length > 0 && (
                  // Definição de pronto (P2): requisitos AUSENTES do conjunto (manifesto/teste/README). Como a
                  // falta é do CONJUNTO (não de um arquivo), aparece aqui como aviso project-level e bloqueia o
                  // Aplicar de todos — o dev gera o que falta e re-roda.
                  <div style={{ marginTop: 6 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: "#d16969" }}>{t("plan.dodHeader")}</div>
                    {(gate.dod ?? []).map((e, i) => (
                      <div key={i} className="mono" style={{ marginTop: 3, fontSize: 11, color: "#d16969", whiteSpace: "pre-wrap" }}>
                        • {e}
                      </div>
                    ))}
                  </div>
                )}
                {(gate.security ?? []).length > 0 && (
                  // Segurança (P2): avisos ADVISORY do bandit (os bloqueantes de ALTO risco já pintam o cartão
                  // do arquivo). Âmbar — informam, não bloqueiam. Os de ALTO risco bloqueiam via `files`.
                  <div style={{ marginTop: 6 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: "#d1a13a" }}>{t("plan.securityHeader")}</div>
                    {(gate.security ?? []).map((e, i) => (
                      <div key={i} className="mono" style={{ marginTop: 3, fontSize: 11, color: "#d1a13a", whiteSpace: "pre-wrap" }}>
                        • {e}
                      </div>
                    ))}
                  </div>
                )}
                {(gate.deadImports ?? []).length > 0 && (
                  // Imports mortos (F-18): avisos ADVISORY do ruff (F401). Âmbar — NUNCA bloqueiam (não entram
                  // em `files`/gateErrors, então a borda/ícone do banner não mudam).
                  <div style={{ marginTop: 6 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: "#d1a13a" }}>{t("plan.deadImportsHeader")}</div>
                    {(gate.deadImports ?? []).map((e, i) => (
                      <div key={i} className="mono" style={{ marginTop: 3, fontSize: 11, color: "#d1a13a", whiteSpace: "pre-wrap" }}>
                        • {e}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="plan-list">
              {files.map((f) => {
                const errs = gateErrors.get(normPath(f.path)) ?? [];
                const blocked = errs.length > 0;
                return (
                  <div
                    key={f.path}
                    className="plan-item"
                    title={`${f.path}\n\n${f.purpose || t("plan.noPurpose")}${f.deps.length ? `\n\n${t("plan.dependsOn", { deps: f.deps.join(", ") })}` : ""}${blocked ? `\n\n${t("plan.gateFailedTip")}\n${errs.join("\n")}` : ""}`}
                  >
                    <span className="dot" style={{ background: blocked ? STATUS_DOT.failed : STATUS_DOT[f.status] }} title={blocked ? t("plan.gateFailedDot") : statusLabel(f.status)} />
                    <div className="plan-file">
                      <span className="mono">{f.path}</span>
                      <span className="purpose">{blocked ? errs[0] : f.purpose}</span>
                    </div>
                    <span className="plan-st" style={{ color: blocked ? STATUS_DOT.failed : STATUS_DOT[f.status] }}>
                      {blocked ? t("plan.blocked") : statusLabel(f.status)}
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="actions" style={{ marginTop: 12, justifyContent: "flex-end", gap: 8 }}>
              {!proj.done ? (
                <>
                  <button className="btn" disabled={proj.busy} onClick={() => { post({ type: "project/cancel" }); close(); }}>
                    {t("common.cancel")}
                  </button>
                  <button
                    className="btn p"
                    disabled={proj.busy}
                    onClick={() => {
                      dispatch({ kind: "project/generating" });
                      post({ type: "project/generate" });
                    }}
                  >
                    {proj.busy ? (
                      <>
                        <Icon name="refresh" size={13} className="spin" /> {t("common.generating")}
                      </>
                    ) : (
                      <>
                        <Icon name="check" size={13} /> {t("plan.approve")}
                      </>
                    )}
                  </button>
                </>
              ) : (
                <>
                  <button className="btn" onClick={close}>
                    {t("common.close")}
                  </button>
                  {gate && (gate.files.length > 0 || gate.dod.length > 0) && !gate.contractBlocked && (
                    // Escape consciente do gate no lote: aplica TAMBÉM os arquivos reprovados (revisados pelo
                    // dev). Auditável (cada um vira proposal.applied {forced}). Só aparece se há bloqueados —
                    // e some sob a política de contrato (o host recusaria: o force não fura a política).
                    <button
                      className="btn"
                      style={{ borderColor: "#d1a13a", color: "#d1a13a" }}
                      title={t("plan.forceTitle")}
                      onClick={() => post({ type: "proposal/applyAll", forceBlocked: true })}
                    >
                      <Icon name="alert-triangle" size={13} /> {t("plan.force")}
                    </button>
                  )}
                  {gate && gate.requiresContractConfirm && !gate.contractBlocked && !(gate.files.length > 0 || gate.dod.length > 0) && (
                    // Contrato cross-file NÃO verificado (o mypy não rodou): o "Aplicar tudo" pede confirmação.
                    // Este é o "sim, gravar sem verificação" — o dev revisou e assume. forceBlocked = confirmo.
                    <button
                      className="btn"
                      style={{ borderColor: "#d1a13a", color: "#d1a13a" }}
                      title={t("plan.applyNoContractTitle")}
                      onClick={() => post({ type: "proposal/applyAll", forceBlocked: true })}
                    >
                      <Icon name="alert-triangle" size={13} /> {t("plan.applyNoContract")}
                    </button>
                  )}
                  {gate && gate.contractBlocked && (
                    // Política do admin (forge.gate.blockUnverifiedContract): SEM escape — o contrato precisa
                    // ser verificado de fato. Caminho: preparar o ambiente (venv) e re-verificar as MESMAS
                    // propostas; o host recusa Aplicar tudo/Forçar/cartões enquanto isso.
                    <button
                      className="btn"
                      style={{ borderColor: "#d16969", color: "#d16969" }}
                      title={t("plan.envRequiredTitle")}
                      onClick={() => post({ type: "env/prepare" })}
                    >
                      <Icon name="plug" size={13} /> {t("plan.envRequired")}
                    </button>
                  )}
                  {gate && (gate.contractBlocked || gate.requiresContractConfirm) && (
                    // Re-roda o gate sobre as propostas EXISTENTES (sem regenerar): com o venv preparado, o
                    // gate instala o mypy nele e verifica de fato — fecha o ciclo da política sem custo de LLM.
                    <button
                      className="btn"
                      title={t("plan.regateTitle")}
                      onClick={() => post({ type: "project/regate" })}
                    >
                      <Icon name="refresh" size={13} /> {t("plan.regate")}
                    </button>
                  )}
                  <button className="btn p" disabled={!anyComplete} title={t("plan.applyAllTitle")} onClick={() => post({ type: "proposal/applyAll" })}>
                    <Icon name="check" size={13} /> {t("plan.applyAll")}
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Visualizador read-only: aba de Skills (lista + corpo do SKILL.md) e aba de RAG (status + arquivos
// indexados + chunks de um arquivo). Só LEITURA — os dados vêm do que já está em memória no host.
function InspectPanel({ state, onClose, initialSkill }: { state: UIState; onClose: () => void; initialSkill?: string | null }): JSX.Element {
  const [tab, setTab] = useState<"skills" | "rag">("skills");
  // Deep-link do cartão de papel: abre já NA skill clicada (senão o title do chip prometeria
  // "ver o SKILL.md" e entregaria só a lista geral).
  const [selSkill, setSelSkill] = useState<string | null>(initialSkill ?? null);
  const [selFile, setSelFile] = useState<string | null>(null);
  const insp = state.inspect;
  const rag = insp?.rag;
  useEffect(() => {
    // Pede o corpo da skill do deep-link uma vez, na montagem (o cache pode ter sido zerado pelo
    // skills/inspect que chega logo antes — a ordem host é inspect/open → skills/body).
    if (initialSkill) post({ type: "skills/body", name: initialSkill });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Usa "chave presente?" (não truthiness) — um SKILL.md só-frontmatter tem corpo "" e não deve
  // reler o disco a cada clique.
  const openSkill = (s: SkillInspectView) => {
    setSelSkill(s.name);
    if (!insp || !(s.name in insp.skillBody)) post({ type: "skills/body", name: s.name });
  };
  const openFile = (relPath: string) => {
    setSelFile(relPath);
    if (!insp || !(relPath in insp.ragFile)) post({ type: "rag/file", relPath });
  };

  const srcColor: Record<string, string> = { managed: "#c9a26d", user: "#7fb3d5", workspace: "#86c98e" };
  const body = selSkill ? insp?.skillBody[selSkill] : undefined;
  const chunks: RagChunkView[] | undefined = selFile ? insp?.ragFile[selFile] : undefined;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal inspect-modal" onClick={(e) => e.stopPropagation()}>
        <div className="card-title">
          <Icon name="database" size={15} color="#7fb3d5" /> {t("insp.title")}
          <div className="spacer" />
          <span className="icon-btn" title={t("common.close")} onClick={onClose}>
            <Icon name="x" size={15} />
          </span>
        </div>

        <div className="inspect-tabs">
          <button className={`inspect-tab ${tab === "skills" ? "on" : ""}`} onClick={() => setTab("skills")}>
            <Icon name="puzzle" size={12} /> Skills {insp ? `· ${insp.skills.length}` : ""}
          </button>
          <button className={`inspect-tab ${tab === "rag" ? "on" : ""}`} onClick={() => setTab("rag")}>
            <Icon name="database" size={12} /> RAG {rag ? t("insp.ragFiles", { count: rag.files }) : ""}
          </button>
        </div>

        {/* Navegação EMPILHADA (revisão de UX: as duas colunas lado a lado ficavam espremidas e
            ilegíveis): a LISTA ocupa a largura toda; clicar abre o DETALHE em tela cheia do modal,
            com "← voltar". Caches lazy e invalidação anti-stale preservados. */}
        {tab === "skills" ? (
          selSkill ? (
            <div className="inspect-stack">
              <div className="inspect-back">
                <button className="btn" onClick={() => setSelSkill(null)}>
                  {t("insp.back")}
                </button>
                <span className="inspect-path">{insp?.skills.find((s) => s.name === selSkill)?.relFile}</span>
              </div>
              <div className="inspect-detail full">
                {body === undefined ? (
                  <div className="profile-empty">{t("common.loading")}</div>
                ) : (
                  <div className="inspect-md">
                    <Markdown text={body} />
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="inspect-list full">
              {!insp ? (
                <div className="profile-empty">{t("common.loading")}</div>
              ) : insp.skills.length === 0 ? (
                <div className="profile-empty">{t("insp.noSkills")}</div>
              ) : (
                insp.skills.map((s) => (
                  <div key={s.name} className="inspect-item roomy" onClick={() => openSkill(s)}>
                    {/* âmbar = desabilitada (mesma cor do cartão de papel — vocabulário unificado) */}
                    <span className="dot" style={{ background: s.enabled ? "#86c98e" : "#c9a26d" }} />
                    <span className="nm">{s.name}</span>
                    <span className="desc">{s.description}</span>
                    <span className="src" style={{ color: srcColor[s.source] ?? "#9a9a9a" }}>
                      {s.source}
                    </span>
                  </div>
                ))
              )}
            </div>
          )
        ) : selFile ? (
          <div className="inspect-stack">
            <div className="inspect-back">
              <button className="btn" onClick={() => setSelFile(null)}>
                {t("insp.back")}
              </button>
              <span className="inspect-path">{selFile}</span>
            </div>
            <div className="inspect-detail full">
              {chunks === undefined ? (
                <div className="profile-empty">{t("common.loading")}</div>
              ) : (
                chunks.map((c) => (
                  <div key={c.id} className="rag-chunk">
                    <div className="rag-chunk-head">
                      L{c.startLine}–{c.endLine}
                      {c.symbol ? ` · ${c.symbol}` : ""}
                      <span className="spacer" />
                      {c.hasVector ? t("insp.vector") : t("insp.noVector")}
                    </div>
                    <pre className="rag-chunk-body">{c.preview}</pre>
                  </div>
                ))
              )}
            </div>
          </div>
        ) : (
          <div className="inspect-list full">
            {!rag ? (
              <div className="profile-empty">{t("common.loading")}</div>
            ) : (
              <>
                <div className="rag-status">
                  <div>
                    {t("insp.mode")} <b>{rag.mode}</b> · {rag.ready ? t("insp.ready") : t("insp.indexing")}
                  </div>
                  <div>
                    {t("insp.stats", { files: rag.files, chunks: rag.chunks })}
                    {rag.capped ? ` ${t("insp.cap", { max: rag.maxChunks })}` : ""}
                  </div>
                  <div className="muted">
                    {rag.mode === "embeddings" ? `${rag.embeddingModel}${rag.dimensions ? ` · ${rag.dimensions}d` : ""}` : t("insp.lexical")}
                  </div>
                </div>
                {rag.fileList.length === 0 ? (
                  <div className="profile-empty">{t("insp.nothingIndexed")}</div>
                ) : (
                  rag.fileList.map((f) => (
                    <div key={f.relPath} className="inspect-item roomy" onClick={() => openFile(f.relPath)}>
                      <span className="nm mono">{f.relPath}</span>
                      <span className="spacer" />
                      <span className="src">{f.chunks} chunk{f.chunks === 1 ? "" : "s"}</span>
                    </div>
                  ))
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// Charter Wizard: redige Propósito/Regras/RF/RNF com auxílio do modelo e grava no .forge/project.md.
// Cada seção tem um textarea (fonte da verdade no estado global) e "Redigir com IA", que envia o
// rascunho atual como brief e substitui o conteúdo pelo texto do modelo.
// label/placeholder são CHAVES do catálogo (resolvidas via t() no render — const módulo-nível avalia
// antes do initLocale); `key` é a chave ESTÁVEL do protocolo (nunca traduz).
const CHARTER_UI: { key: CharterKey; labelKey: MessageKey; rows: number; phKey: MessageKey }[] = [
  { key: "purpose", labelKey: "chart.purpose", rows: 3, phKey: "chart.purposePh" },
  { key: "rules", labelKey: "chart.rules", rows: 5, phKey: "chart.rulesPh" },
  { key: "fr", labelKey: "chart.fr", rows: 6, phKey: "chart.frPh" },
  { key: "nfr", labelKey: "chart.nfr", rows: 6, phKey: "chart.nfrPh" },
];

function CharterWizard({
  state,
  dispatch,
  onClose,
}: {
  state: UIState;
  dispatch: React.Dispatch<Action>;
  onClose: () => void;
}): JSX.Element {
  const charter = state.charter;
  const anyDrafting = charter ? Object.values(charter.drafting).some(Boolean) : false;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal charter-modal" onClick={(e) => e.stopPropagation()}>
        <div className="card-title">
          <Icon name="sparkles" size={15} color="#c9a26d" /> {t("chart.title")}
          <div className="spacer" />
          <span className="icon-btn" title={t("common.close")} onClick={onClose}>
            <Icon name="x" size={15} />
          </span>
        </div>
        <div className="charter-hint">{t("chart.hint")}</div>
        {!charter ? (
          <div className="profile-empty">{t("common.loading")}</div>
        ) : (
          <>
            {CHARTER_UI.map((sec) => {
              const drafting = charter.drafting[sec.key];
              const note = charter.notes[sec.key];
              return (
                <div key={sec.key} className="charter-sec">
                  <div className="profile-sec" style={{ display: "flex", alignItems: "center", marginBottom: 4 }}>
                    {t(sec.labelKey)}
                    <div className="spacer" />
                    <button
                      className="btn"
                      disabled={drafting}
                      title={t("chart.draftTitle")}
                      // sections: o estado ATUAL do wizard (inclui o não salvo) — um Propósito recém-
                      // digitado ancora a redação de Regras/RF/RNF vazios sem exigir "Salvar" antes.
                      onClick={() => post({ type: "charter/draft", section: sec.key, brief: charter.sections[sec.key], sections: charter.sections })}
                    >
                      <Icon name={drafting ? "refresh" : "sparkles"} size={12} className={drafting ? "spin" : ""} />{" "}
                      {drafting ? t("chart.drafting") : t("chart.draft")}
                    </button>
                  </div>
                  {note && (
                    // Aviso/erro do rascunho ANCORADO na seção (ex.: truncou no limite de tokens; modelo
                    // não retornou conteúdo). Um toast ficaria atrás do backdrop e sumiria em 5s.
                    <div className="assistant-warning" style={{ marginBottom: 4, ...(note.level === "error" ? { color: "#e5534b" } : {}) }}>
                      <Icon name="alert-triangle" size={13} /> {note.message}
                    </div>
                  )}
                  <textarea
                    className="charter-input"
                    rows={sec.rows}
                    placeholder={t(sec.phKey)}
                    value={charter.sections[sec.key]}
                    disabled={drafting}
                    onChange={(e) => dispatch({ kind: "charter/edit", section: sec.key, text: e.target.value })}
                  />
                </div>
              );
            })}
            <div className="actions" style={{ marginTop: 12, justifyContent: "flex-end", gap: 8 }}>
              <button className="btn" title={t("chart.openMdTitle")} onClick={() => post({ type: "profile/open" })}>
                <Icon name="code" size={13} /> {t("chart.openMd")}
              </button>
              <button
                className="btn"
                disabled={state.busy || anyDrafting || !(charter.sections.fr.trim() || charter.sections.nfr.trim())}
                title={t("chart.genTestsTitle")}
                onClick={() => {
                  // bolha fiel: mostra no transcript os requisitos efetivamente enviados ao modelo.
                  const reqs = [charter.sections.fr.trim(), charter.sections.nfr.trim()].filter(Boolean).join("\n\n");
                  dispatch({ kind: "pushUser", text: `${t("chart.genTestsEcho")}\n\n${reqs}` });
                  post({ type: "charter/genTests", fr: charter.sections.fr, nfr: charter.sections.nfr });
                  onClose();
                }}
              >
                <Icon name="terminal" size={13} /> {t("chart.genTests")}
              </button>
              <button
                className="btn p"
                disabled={anyDrafting}
                onClick={() => {
                  post({ type: "charter/save", sections: charter.sections });
                  onClose(); // fecha o modal e volta à tela principal (o toast "Charter salvo…" confirma)
                }}
              >
                <Icon name="check" size={13} /> {t("common.save")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ProfilePanel({ profile, onClose, onWizard }: { profile: ProfileView | null; onClose: () => void; onWizard: () => void }): JSX.Element {
  const s = profile?.stack;
  const stackRows: [string, string | undefined][] = [
    [t("prof.language"), s?.language],
    [t("prof.packaging"), s?.packaging],
    [t("prof.lint"), s?.lintFormat.join(", ") || undefined],
    [t("prof.types"), s?.types.join(", ") || undefined],
    [t("prof.tests"), s?.tests],
    [t("prof.libs"), s?.libs.slice(0, 12).join(", ") || undefined],
  ];
  const detected = stackRows.filter(([, v]) => v);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal profile-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header FIXO: fechar sem rolar (em laptop de pouca altura a caixa TODA rolava). */}
        <div className="card-title">
          <Icon name="list-check" size={15} color="#4ec9b0" /> {t("prof.title")}
          <div className="spacer" />
          <span className="icon-btn" title={t("common.close")} onClick={onClose}>
            <Icon name="x" size={15} />
          </span>
        </div>

        {/* Miolo ROLÁVEL em grid de 2 colunas (colapsa p/ 1 em painel estreito): mais horizontal,
            menos vertical — o conteúdo respira e o scroll fica só onde precisa. */}
        <div className="profile-body">
          <div className="profile-grid">
            <div>
              <div className="profile-sec">{t("prof.stack")}</div>
              {!profile ? (
                <div className="profile-empty">{t("common.loading")}</div>
              ) : detected.length === 0 ? (
                <div className="profile-empty">{t("prof.nothingDetected")}</div>
              ) : (
                <div className="profile-stack">
                  {detected.map(([k, v]) => (
                    <div key={k} className="profile-kv">
                      <span className="k">{k}</span>
                      <span className="v">{v}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div>
              <div className="profile-sec">{t("prof.role")}</div>
              <div className="profile-row">
                <span style={{ color: profile?.role ? "#cfcfcf" : "#7a7a7a" }}>{profile?.role ?? t("prof.roleUndefined")}</span>
                <div className="spacer" />
                <button className="btn" onClick={() => post({ type: "profile/pickRole" })}>
                  <Icon name="users" size={12} /> {profile?.role ? t("prof.change") : t("prof.define")}
                </button>
              </div>

              <div className="profile-sec">{t("prof.rules", { count: profile?.rules.length ?? 0 })}</div>
              <div className="profile-rules">
                {profile && profile.rules.length === 0 && <div className="profile-empty">{t("prof.noRules")}</div>}
                {(profile?.rules ?? []).map((r, i) => (
                  <div key={i} className="profile-rule">
                    <Icon name="point" size={13} /> {r}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Footer FIXO: ações sempre visíveis. */}
        <div className="actions" style={{ marginTop: 10, marginBottom: 0, justifyContent: "flex-end", gap: 8 }}>
          <button className="btn" title={t("chart.openMdTitle")} onClick={() => post({ type: "profile/open" })}>
            <Icon name="code" size={13} /> {t("chart.openMd")}
          </button>
          <button className="btn p" title={t("prof.wizardTitle")} onClick={onWizard}>
            <Icon name="sparkles" size={13} /> {t("prof.wizard")}
          </button>
        </div>
      </div>
    </div>
  );
}

function UserBubble({ m }: { m: MessageVM }): JSX.Element {
  return <div className="user-msg">{m.text}</div>;
}

function AssistantBlock({ m, dispatch }: { m: MessageVM; dispatch: React.Dispatch<Action> }): JSX.Element {
  const [showReasoning, setShowReasoning] = useState(false);
  // Cartões "ao vivo" só fazem sentido DURANTE a geração: quando o stream termina (sucesso, abort
  // ou erro), os blocos válidos já viraram propostas concretas (e o reducer removeu sua cerca do
  // texto). Fora do streaming não fabricamos preview nem removemos cerca — evita cartão-zumbi e
  // perda de conteúdo se a geração for interrompida (o texto cru reaparece, sem travar a UI).
  const proposedPaths = new Set(m.proposals.map((p) => p.proposal.filePath));
  const previews = m.streaming
    ? parsePartialFileBlocks(m.text).filter((b) => !proposedPaths.has(b.path))
    : [];
  // Sempre remove as cercas forge-file/forge-cell do texto exibido — inclusive fora do streaming.
  // No caminho de erro/abort o reducer não chega a transformar o bloco em proposta (nem a removê-lo),
  // então sem este strip a cerca crua "vazaria" como uma caixa de código enganosa no Markdown.
  const displayText = stripFileBlocksFromText(m.text);
  const liveBlock = previews.some((b) => !b.closed); // algum bloco ainda chegando
  const hasCards = previews.length > 0 || m.proposals.length > 0;
  const thinking = m.streaming && !displayText && !hasCards;
  return (
    <div className="assistant">
      {m.skills.map((s) => (
        <div key={s} className="skill-badge">
          <Icon name="puzzle" size={13} /> {t("asst.skillApplied", { name: s })}
        </div>
      ))}
      {m.reasoning && (
        <div className="reasoning-box">
          <button className="reasoning-toggle" onClick={() => setShowReasoning((v) => !v)}>
            <Icon
              name="chevron-down"
              size={12}
              style={{ transform: showReasoning ? "none" : "rotate(-90deg)", transition: "transform .12s" }}
            />
            {thinking ? t("asst.reasoningLive") : t("asst.reasoning")}
            {thinking && <Icon name="refresh" size={11} className="spin" style={{ marginLeft: 2 }} />}
          </button>
          {showReasoning && (
            <div className="reasoning">
              <Markdown text={m.reasoning} />
            </div>
          )}
        </div>
      )}
      {displayText && (
        <div className="assistant-text">
          <Markdown
            text={displayText}
            streaming={m.streaming}
            trailing={m.streaming && !liveBlock && !m.proposals.length ? <span className="blink">▏</span> : undefined}
          />
        </div>
      )}
      {!displayText && !m.reasoning && m.streaming && !hasCards && (
        <div className="assistant-text" style={{ color: "#7a7a7a" }}>
          <Icon name="refresh" size={13} className="spin" /> {t("common.generating")}
        </div>
      )}
      {previews.map((b, idx) => (
        <PreviewCard key={`pv_${b.path || idx}`} block={b} />
      ))}
      {m.proposals.map((p) => (
        <ProposalCard key={p.proposal.id} p={p} dispatch={dispatch} />
      ))}
      {m.warning && (
        <div className="assistant-warning" style={{ marginTop: 4 }}>
          <Icon name="alert-triangle" size={14} /> {m.warning}
        </div>
      )}
      {m.error && (
        <div className="validation fail" style={{ marginTop: 4 }}>
          <Icon name="alert-triangle" size={14} /> {m.error}
        </div>
      )}
    </div>
  );
}

// Cartão "ao vivo" enquanto o modelo ainda está gerando um arquivo: mostra o caminho e o código
// que vai chegando, com a ação primária já visível (desabilitada até a geração concluir). Só é
// renderizado durante o streaming; quando a proposta concreta — com diff e validação — chega, ela
// toma seu lugar. `block.closed` indica que ESTE arquivo já terminou (mesmo com o stream seguindo
// em outro bloco/prosa), então paramos de exibir "gerando…" e o cursor neste cartão.
function PreviewCard({ block }: { block: PartialFileBlock }): JSX.Element {
  const live = !block.closed;
  const codeRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    codeRef.current?.scrollTo({ top: codeRef.current.scrollHeight });
  }, [block.content]);
  return (
    <div>
      <div className="diff-card">
        <div className="diff-head">
          <span className="left">
            <Icon name="file-code" size={13} color="#4ec9b0" /> {block.path || t("pv.newFile")}
          </span>
          {live ? (
            <span className="gen-pill">
              <Icon name="refresh" size={12} className="spin" /> {t("common.generating")}
            </span>
          ) : (
            <span className="gen-pill" style={{ color: "var(--green-soft)" }}>
              <Icon name="check" size={12} /> {t("pv.ready")}
            </span>
          )}
        </div>
        <pre className="preview-code" ref={codeRef}>
          {block.content}
          {live && <span className="blink">▏</span>}
        </pre>
      </div>
      <div className="actions">
        <button className="btn p" disabled title={t("pv.availableAfter")}>
          <Icon name="check" size={13} /> {t("pv.applyOpen")}
        </button>
        <button className="btn" disabled>
          <Icon name="git-compare" size={13} /> {t("common.viewDiff")}
        </button>
      </div>
    </div>
  );
}

function ProposalCard({ p, dispatch }: { p: ProposalVM; dispatch: React.Dispatch<Action> }): JSX.Element {
  const v = p.validation;
  const gateFailed = v && !v.running && !v.gateOk;
  const labels = v?.results.map((r) => r.label).join(" + ") || t("prop.validationFallback");
  const skipped = v?.results.filter((r) => r.status === "skipped").map((r) => r.label) ?? [];
  const cell = p.proposal.cell;
  // Artefato renderável (.html/.svg): "executar" vira "visualizar" (abre no painel de preview).
  const renderable = !cell && isRenderablePath(p.proposal.filePath);
  const openPreview = () => post({ type: "preview/open", filePath: p.proposal.filePath, proposalId: p.proposal.id });
  const [menuOpen, setMenuOpen] = useState(false);
  const applyLabel = cell ? (cell.op === "add" ? t("prop.insertCell") : t("prop.replaceCell", { index: cell.index ?? "" })) : t("pv.applyOpen");

  return (
    <div>
      <div className="diff-card">
        <div className="diff-head">
          <span className="left">
            <Icon name={cell ? "terminal" : "code"} size={13} color="#4ec9b0" />{" "}
            {cell ? `${t("prop.cell")} · ${p.proposal.filePath} · ${p.proposal.summary}` : `diff · ${p.proposal.filePath}`}
          </span>
          {!cell && (
            // O detector de completude (cerca-aberta/elipse) só roda em blocos forge-file; para células
            // não há verificação, então não afirmamos completude que não checamos.
            <span
              className={`seal ${p.proposal.partial ? "partial" : "ok"}`}
              title={p.proposal.partial ? t("prop.partialSealTitle") : t("prop.completeSealTitle")}
            >
              {p.proposal.partial ? t("prop.partialSeal") : t("prop.completeSeal")}
            </span>
          )}
          <span className="diff-lang">{p.proposal.language}</span>
        </div>
        <DiffView original={p.proposal.original} modified={p.proposal.modified} />
      </div>

      {p.proposal.partial && p.status !== "applied" && (
        <div className="assistant-warning" style={{ marginTop: 4 }}>
          <Icon name="alert-triangle" size={14} /> {t("prop.partialWarning")}
        </div>
      )}

      {v && (
        <div className={`validation ${v.running ? "run" : v.gateOk ? "ok" : "fail"}`}>
          <Icon name={v.running ? "refresh" : "list-check"} size={14} className={v.running ? "spin" : ""} />
          {v.running ? (
            t("prop.validationRunning")
          ) : (
            <>
              {t("prop.validation")} · {labels}
              <span className="sep">·</span>
              <span className="gate">
                <Icon name={v.gateOk ? "shield-check" : "alert-triangle"} size={13} />
                {v.gateOk ? t("prop.gateOk") : t("prop.gateFailed")}
              </span>
              {skipped.length > 0 && <span style={{ color: "#7a7a7a" }}>· {t("prop.unavailable", { labels: skipped.join(", ") })}</span>}
            </>
          )}
        </div>
      )}

      {p.status === "applied" ? (
        <div className="actions">
          <div className="status-applied" style={{ marginBottom: 0 }}>
            <Icon name="check" size={13} /> {cell ? t("prop.cellApplied") : t("prop.appliedAt", { path: p.proposal.filePath })}
          </div>
          <div className="spacer" />
          {cell ? (
            <button className="btn" title={t("prop.runCellTitle")} onClick={() => post({ type: "cell/run", proposalId: p.proposal.id })}>
              <Icon name="player-play" size={12} /> {t("prop.runCell")}
            </button>
          ) : renderable ? (
            <button className="btn" title={t("prop.previewTitle")} onClick={openPreview}>
              <Icon name="eye" size={12} /> {t("prop.preview")}
            </button>
          ) : p.run?.running ? (
            <button className="btn" disabled title={t("prop.runningTitle")}>
              <Icon name="refresh" size={12} className="spin" /> {t("prop.running")}
            </button>
          ) : (
            <button
              className="btn"
              title={t("prop.runFileTitle")}
              onClick={() => post({ type: "run/file", filePath: p.proposal.filePath, proposalId: p.proposal.id })}
            >
              <Icon name="player-play" size={12} /> {p.run ? t("prop.rerun") : t("prop.run")}
            </button>
          )}
        </div>
      ) : p.status === "discarded" ? (
        <div className="status-discarded">{t("prop.discarded")}</div>
      ) : (
        <div className="actions">
          <button
            className="btn p"
            disabled={!!(v && (v.running || gateFailed))}
            title={gateFailed ? t("prop.applyGateFailedTitle") : cell ? t("prop.applyCellTitle") : t("prop.applyFileTitle")}
            onClick={() => post({ type: "proposal/apply", proposalId: p.proposal.id })}
          >
            <Icon name="check" size={13} /> {applyLabel}
          </button>
          {gateFailed && (
            // Escape CONSCIENTE do gate reprovado (arquitetura/DoD/segurança/lint): o dev revisou e assume. O
            // override é auditável (obs proposal.applied {forced} + aviso). Só aparece quando o gate reprovou.
            <button
              className="btn"
              style={{ borderColor: "#d1a13a", color: "#d1a13a" }}
              title={t("prop.forceTitle")}
              onClick={() => post({ type: "proposal/apply", proposalId: p.proposal.id, force: true })}
            >
              <Icon name="alert-triangle" size={13} /> {t("prop.force")}
            </button>
          )}
          {!cell && (
            <button
              className="btn"
              disabled={!!(v && (v.running || gateFailed))}
              title={renderable ? t("prop.applyPreviewTitle") : t("prop.applyRunTitle")}
              onClick={() =>
                post({ type: renderable ? "proposal/applyAndPreview" : "proposal/applyAndRun", proposalId: p.proposal.id })
              }
            >
              <Icon name={renderable ? "eye" : "player-play"} size={13} /> {renderable ? t("prop.applyPreview") : t("prop.applyRun")}
            </button>
          )}
          <button className="btn" onClick={() => post({ type: "proposal/viewDiff", proposalId: p.proposal.id })}>
            <Icon name="git-compare" size={13} /> {t("common.viewDiff")}
          </button>
          <div className="spacer" />
          <div className="ovf">
            <button className="btn ovf-btn" title={t("prop.moreActions")} onClick={() => setMenuOpen((vv) => !vv)}>
              <Icon name="dots" size={14} />
            </button>
            {menuOpen && (
              <>
                <div className="ovf-backdrop" onClick={() => setMenuOpen(false)} />
                <div className="ovf-menu">
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      post({ type: "proposal/copy", proposalId: p.proposal.id });
                    }}
                  >
                    <Icon name="copy" size={13} /> {t("prop.copyContent")}
                  </button>
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      post({ type: "proposal/discard", proposalId: p.proposal.id });
                    }}
                  >
                    <Icon name="x" size={13} /> {t("prop.discard")}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {p.run && <RunCard run={p.run} dispatch={dispatch} />}
    </div>
  );
}

function RunCard({
  run,
  dispatch,
  onDismiss,
}: {
  run: RunResultData;
  dispatch: React.Dispatch<Action>;
  onDismiss?: () => void; // presente só nos cartões soltos da thread (permite "Ocultar")
}): JSX.Element {
  const running = !!run.running;
  const [open, setOpen] = useState(running || !run.ok);
  const [elapsed, setElapsed] = useState(0);
  const outRef = useRef<HTMLPreElement>(null);

  // Cronômetro ao vivo enquanto executa, para o cartão nunca parecer travado.
  useEffect(() => {
    if (!running) return;
    setOpen(true);
    const t0 = Date.now();
    const id = setInterval(() => setElapsed(Date.now() - t0), 200);
    return () => clearInterval(id);
  }, [running]);
  // Auto-scroll da saída que vai chegando.
  useEffect(() => {
    if (running) outRef.current?.scrollTo({ top: outRef.current.scrollHeight });
  }, [run.output, running]);

  const isTests = !!run.isTest;
  const outcome: TestOutcome | null = isTests && !running ? pytestOutcome(run.exitCode, run.output) : null;
  // Para testes, o status vem do outcome semântico (exit 5 = neutro, não vermelho). Para execução de
  // arquivo, segue o ok booleano. "Corrigir com FORGE" só faz sentido quando os testes de fato falharam.
  const status = running
    ? "run"
    : run.skippedReason
    ? "skip"
    : outcome
    ? outcome === "passed"
      ? "ok"
      : outcome === "no-tests" || outcome === "env-missing"
      ? "skip" // ambiente incompleto = neutro-ACIONÁVEL (botão de instalação), não vermelho-morto
      : "fail"
    : run.ok
    ? "ok"
    : "fail";
  const canFix = outcome ? outcome === "failed" : status === "fail";
  // A semântica pytest só vale para comandos da família pytest — com o fallback `npm test` (Node),
  // "env-missing" significa runner do Node ausente (npm install), não pytest.
  const npmTests = isTests && /^npm\b/i.test(run.command || "");
  // pytest ausente no ambiente: reoferece o fluxo de Testes — o pré-flight do host detecta e
  // instala no venv (com confirmação ou autoInstall), depois roda.
  const testsEnvMissing = outcome === "env-missing" && !npmTests;
  // Falha por dependência ausente (ModuleNotFoundError) é problema de AMBIENTE, não de código:
  // oferece "Preparar ambiente" (venv + install) em vez de mandar o modelo "corrigir" o import.
  // Vale para runs de ARQUIVO (status fail) e para TESTES com erro de coleta (pytest instalado,
  // dependência da aplicação ausente — outcome "error", não "failed").
  const envIssue =
    !running &&
    /ModuleNotFoundError|No module named/.test(run.output) &&
    ((!isTests && status === "fail") || (isTests && outcome === "error"));
  const title = run.label ? run.label : run.command || t("run.fallbackTitle");
  const headIcon = running ? "refresh" : status === "ok" ? "check" : status === "skip" ? "info-circle" : isTests ? "terminal" : "alert-triangle";
  // O conserto precisa voltar como bloco forge-file — o ÚNICO formato que o FORGE transforma numa
  // proposta com botão "Aplicar". Sem reforçar isto, o modelo tende a devolver o código em cerca
  // comum (três crases) + "substitua o conteúdo de X", que o dev só consegue copiar/colar à mão.
  const applyProtocol =
    "Emita o arquivo corrigido como um bloco forge-file (QUATRO crases, cabeçalho `path=`), com o " +
    "conteúdo COMPLETO e final do arquivo. NÃO descreva a mudança em prosa nem cole o código em cerca " +
    "comum de três crases pedindo para eu copiar/colar — cerca comum não vira uma proposta aplicável.";
  // A saída do runner vai delimitada por um RÓTULO textual (não por cerca de crases): uma cerca de três
  // crases aqui vira um exemplo de formatação que o modelo espelha, devolvendo cerca comum no lugar do bloco.
  const evidence = `--- saída (apenas diagnóstico, não reformatar) ---\n${run.output.slice(-2500)}\n--- fim da saída ---`;
  const fixText =
    outcome === "failed"
      ? `Os testes falharam.\n${evidence}\n\nCorrija o CÓDIGO para os testes passarem (sem enfraquecer os testes). ${applyProtocol} Use no \`path=\` o arquivo que você corrigir.`
      : `A execução de \`${run.filePath}\` falhou (exit ${run.exitCode ?? "?"}).\n${evidence}\n\nCorrija o arquivo. ${applyProtocol} Use \`path=${run.filePath}\`.`;
  return (
    <div className="run-card">
      <div className={`run-head ${status}`} onClick={() => !running && setOpen((v) => !v)}>
        <Icon name={headIcon} size={13} className={running ? "spin" : ""} />
        <span style={{ fontFamily: "var(--mono)" }}>{title}</span>
        <div className="spacer" />
        {running ? (
          <span>
            {run.where === "terminal" ? t("run.inTerminal") : t("run.executing")} · {(elapsed / 1000).toFixed(1)}s
          </span>
        ) : run.skippedReason ? (
          <span>{t("run.unavailable")}</span>
        ) : (
          <span>
            {outcome
              ? npmTests && outcome === "env-missing"
                ? t("run.npmMissing")
                : outcomeLabel(outcome, run.exitCode)
              : run.ok
              ? "ok"
              : `exit ${run.exitCode}`}{" "}
            · {Math.round(run.durationMs)} ms
          </span>
        )}
        {!running && (
          <Icon name="chevron-down" size={12} style={{ transform: open ? "none" : "rotate(-90deg)", transition: "transform .12s" }} />
        )}
      </div>
      {open && (run.skippedReason || run.output || running) && (
        <pre className="run-output" ref={outRef}>
          {run.skippedReason ? run.skippedReason : run.output || (running ? t("run.starting") : t("run.noOutput"))}
        </pre>
      )}
      {running ? (
        <div className="actions" style={{ marginTop: 7 }}>
          {run.where === "terminal" && run.runId && (
            <button className="btn" title={t("run.viewTerminalTitle")} onClick={() => post({ type: "run/focusTerminal", runId: run.runId! })}>
              <Icon name="terminal" size={12} /> {t("run.viewTerminal")}
            </button>
          )}
          <div className="spacer" />
          {run.runId && (
            <button className="btn" title={t("run.cancelTitle")} onClick={() => post({ type: "run/cancel", runId: run.runId! })}>
              <Icon name="x" size={12} /> {t("common.cancel")}
            </button>
          )}
        </div>
      ) : (
        (canFix || envIssue || testsEnvMissing || onDismiss) && (
          <div className="actions" style={{ marginTop: 7 }}>
            {testsEnvMissing && (
              <button className="btn p" title={t("run.installPytestTitle")} onClick={() => post({ type: "tests/run" })}>
                <Icon name="plug" size={12} /> {t("run.installPytest")}
              </button>
            )}
            {envIssue && (
              <button className="btn p" title={t("run.prepareEnvTitle")} onClick={() => post({ type: "env/prepare" })}>
                <Icon name="plug" size={12} /> {t("run.prepareEnv")}
              </button>
            )}
            {canFix && (
              <button
                className={envIssue ? "btn" : "btn p"}
                onClick={() => {
                  dispatch({ kind: "pushUser", text: fixText });
                  post({ type: "chat/send", text: fixText });
                }}
              >
                <Icon name="refresh" size={12} /> {t("run.fix")}
              </button>
            )}
            <div className="spacer" />
            {onDismiss && (
              <button className="btn" title={t("run.hideTitle")} onClick={onDismiss}>
                <Icon name="x" size={12} /> {t("run.hide")}
              </button>
            )}
          </div>
        )
      )}
    </div>
  );
}

// Formatação compacta de tokens para a barra de status (1.2k / 340).
function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

// Rótulo exibido do outcome de testes — camada de i18n da webview (o outcome semântico continua em
// src/util/testOutcome.ts; rótulo é apresentação, então mora aqui com t()).
function outcomeLabel(o: TestOutcome, exitCode: number | null): string {
  switch (o) {
    case "passed":
      return t("run.outcome.passed");
    case "failed":
      return t("run.outcome.failed");
    case "no-tests":
      return t("run.outcome.noTests");
    case "env-missing":
      return t("run.outcome.envMissing");
    default:
      return t("run.outcome.error", { code: exitCode ?? "?" });
  }
}

// Cartão pós-seleção do PAPEL: mostra a linha de estilo que passa a entrar em todo prompt e as
// skills relacionadas (chips clicáveis → Índice). Substitui o toast de 5s que sumia antes de ler.
function RoleCardView({ card, onDismiss, onOpenSkill }: { card: RoleCard; onDismiss: () => void; onOpenSkill: (name: string) => void }): JSX.Element {
  return (
    <div className="role-card">
      <div className="role-card-head">
        <Icon name="users" size={14} color="#c9a26d" /> {t("role.defined")} <b>{card.label}</b>
        <div className="spacer" />
        <span className="icon-btn" title={t("common.dismiss")} onClick={onDismiss}>
          <Icon name="x" size={13} />
        </span>
      </div>
      <div className="role-card-guidance">{card.guidance}</div>
      {card.skills.length > 0 && (
        <div className="role-card-skills">
          <span className="role-card-cap">{t("role.relatedSkills")}</span>
          {card.skills.map((s) => (
            <span
              key={s.name}
              className={`role-chip${s.installed ? "" : " off"}`}
              title={
                s.installed
                  ? t("role.chipTitle", { name: s.name, state: s.enabled ? t("role.enabled") : t("role.disabled") })
                  : t("role.notInstalled", { name: s.name })
              }
              onClick={s.installed ? () => onOpenSkill(s.name) : undefined}
            >
              <span className="dot" style={{ background: s.installed ? (s.enabled ? "#86c98e" : "#c9a26d") : "#555" }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// Heurística conservadora: mensagens em tom de diretiva (proibição/preferência) são candidatas a
// virar regra do projeto. Evita perguntas e tarefas longas; foca em "nunca/sempre/evite/prefira…"
// e nos equivalentes en/es. Lições acumuladas das revisões (PRs 7 e 11):
// - "prefer"/"prefiere"/"evita" exigem espaço em seguida (\b é ASCII: "prefer"+"ê" fecharia boundary
//   e "Preferências…" dispararia por engano);
// - radicais levam \w* ("padroniz|standardiz|estandariz" + \b nunca casavam "padronize/standardize/
//   estandariza" — o \b exigia não-letra logo após o radical: gatilho morto);
// - "no use(s)" é diretiva em es mas IDIOM em en ("no use crying over…") — só vale com a UI em es.
function looksLikeRule(text: string): boolean {
  const s = text.trim();
  if (!s || s.length > 200 || s.includes("?")) return false;
  if (/^(nunca|sempre|jamais|evite|prefira|padroniz\w*|n[ãa]o use|never|always|avoid|prefer(?=\s)|standardiz\w*|do not use|don'?t use|siempre|jam[áa]s|prefiera|prefiere(?=\s)|evita(?=\s)|estandariz\w*)\b/i.test(s)) return true;
  return getLocale() === "es" && /^no uses?\s/i.test(s);
}

// "Promover correção a regra": quando a última mensagem do usuário soa como diretiva, oferece
// salvá-la no perfil do projeto com um clique. Dismissível e nunca bloqueante.
function ProfileSuggestion({ messages }: { messages: MessageVM[] }): JSX.Element | null {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser || dismissed.has(lastUser.id)) return null;
  // O prefixo de eco "[TDD]/[Projeto · …]" é gerado com o rótulo TRADUZIDO (t("comp.project")) — o
  // strip precisa casar as duas formas (label traduzido não é chave: aqui a comparação lista ambas).
  const rule = lastUser.text.replace(/^\[(TDD|Projeto[^\]]*|Project[^\]]*|Proyecto[^\]]*)\]\s*/, "").trim();
  if (!looksLikeRule(rule)) return null;
  const close = () => setDismissed((s) => new Set(s).add(lastUser.id));
  return (
    <div className="profile-suggest">
      <Icon name="list-check" size={13} />
      <span>{t("sugg.saveRule")}</span>
      <span className="rule-preview" title={rule}>“{rule.length > 60 ? rule.slice(0, 60) + "…" : rule}”</span>
      <div className="spacer" />
      <button
        className="btn p"
        onClick={() => {
          post({ type: "profile/addRule", rule });
          close();
        }}
      >
        <Icon name="check" size={12} /> {t("common.save")}
      </button>
      <button className="icon-btn" title={t("common.dismiss")} onClick={close}>
        <Icon name="x" size={13} />
      </button>
    </div>
  );
}

type DodStatus = "ok" | "fail" | "partial" | "pending";

function runStatus(r: RunResultData | null): DodStatus {
  if (!r || r.skippedReason) return "pending";
  if (r.isTest) {
    const o = pytestOutcome(r.exitCode, r.output);
    // sem testes coletados / ambiente incompleto = pendente (acionável), não falha da DoD
    return o === "passed" ? "ok" : o === "no-tests" || o === "env-missing" ? "pending" : "fail";
  }
  return r.ok ? "ok" : "fail";
}

function DodBar({ state, dispatch }: { state: UIState; dispatch: React.Dispatch<Action> }): JSX.Element | null {
  const proposals = state.messages.flatMap((m) => m.proposals);
  if (proposals.length === 0) return null;

  const appliedList = proposals.filter((p) => p.status === "applied");
  const lastApplied = appliedList[appliedList.length - 1];
  const applied: DodStatus = appliedList.length ? "ok" : "pending";
  // O passo "Gate": pending até aplicar; "fail" se a validação por-arquivo do último aplicado reprovou;
  // "partial" (âmbar, NÃO verde) se o contrato cross-file do PROJETO não foi verificado (mypy não rodou) —
  // sinalizado por `contractUnverified`, que o gate carimba NA proposta (project/gate). O flag vive na
  // proposta (state.messages), não em state.project — que some ao fechar o modal do projeto, JUSTO quando
  // esta barra fica visível (o modal a cobre enquanto aberto). Sem isto, o "Gate ✓" verde reaparecia pós-
  // fechamento mesmo com o contrato não verificado. Edições de chat (sem carimbo) mantêm a lógica por-arquivo.
  let gate: DodStatus;
  if (!lastApplied) {
    gate = "pending";
  } else if (!!lastApplied.validation && !lastApplied.validation.gateOk) {
    gate = "fail";
  } else if (lastApplied.contractUnverified) {
    gate = "partial";
  } else {
    gate = "ok";
  }
  const run = runStatus(state.lastFileRun);
  const tests = runStatus(state.lastTestRun);
  const review: DodStatus = state.reviewed ? "ok" : "pending";

  const ready = applied === "ok" && gate === "ok" && tests === "ok" && review === "ok";

  const runLastApplied = () => {
    if (lastApplied) post({ type: "run/file", filePath: lastApplied.proposal.filePath, proposalId: lastApplied.proposal.id });
  };
  const doReview = () => {
    dispatch({ kind: "pushUser", text: t("echo.review") });
    post({ type: "review/changes" });
  };

  const items: { key: string; label: string; status: DodStatus; onClick?: () => void; title: string }[] = [
    { key: "aplicado", label: t("dod.applied"), status: applied, title: t("dod.appliedTitle") },
    { key: "gate", label: t("dod.gate"), status: gate, title: gate === "partial" ? t("dod.gatePartialTitle") : t("dod.gateTitle") },
    { key: "executa", label: t("dod.run"), status: run, onClick: runLastApplied, title: t("dod.runTitle") },
    { key: "testes", label: t("dod.tests"), status: tests, onClick: () => post({ type: "tests/run" }), title: t("dod.testsTitle") },
    { key: "revisao", label: t("dod.review"), status: review, onClick: doReview, title: t("dod.reviewTitle") },
  ];

  return (
    <div className={`dod ${ready ? "ready" : ""}`}>
      <span className="dod-title">
        <Icon name={ready ? "circle-check" : "list-check"} size={13} color={ready ? "#3fb950" : "#8b8b8b"} />
        {ready ? t("dod.ready") : t("dod.title")}
      </span>
      {items.map((it) => (
        <span
          key={it.key}
          className={`dod-chip ${it.status} ${it.onClick && it.status !== "ok" ? "clickable" : ""}`}
          title={it.title}
          onClick={it.onClick && it.status !== "ok" ? it.onClick : undefined}
        >
          <Icon name={it.status === "ok" ? "check" : it.status === "fail" ? "x" : it.status === "partial" ? "alert-triangle" : "circle"} size={11} />
          {it.label}
        </span>
      ))}
    </div>
  );
}
