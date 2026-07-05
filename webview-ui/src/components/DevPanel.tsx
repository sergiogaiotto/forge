import React, { useEffect, useRef, useState } from "react";
import { Icon } from "../icons";
import type { Action, MessageVM, PartialFileBlock, ProfileView, ProposalVM, RunResultData, UIState } from "../state";
import { parsePartialFileBlocks, stripFileBlocksFromText } from "../state";
import { post } from "../vscode";
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
import { pytestOutcome, TestOutcome, testOutcomeLabel } from "../../../src/util/testOutcome";
import { classifyProjectIntent } from "../../../src/util/projectIntent";
import { buildDiagramRequest, buildProjectSummaryRequest, exactSlashCommand, matchSlashCommands, normalizeSlash, renderHelp, renderTokensReport, slashWithArgs, type SlashCommand } from "../commands";
import { DiffView } from "./DiffView";
import { Markdown } from "./Markdown";
import { DEFAULT_REASONING_EFFORT, effectiveTimeoutSeconds, MAX_OUTPUT_PRESETS, maxOutputLabel, REASONING_EFFORTS, type ReasoningEffort } from "../../../src/shared/protocol";

const EFFORT_LABEL: Record<ReasoningEffort, string> = { low: "baixo", medium: "médio", high: "alto" };
const PROJ_LANG_LABEL: Record<ProjectLanguage, string> = { python: "Python", typescript: "TypeScript", java: "Java", go: "Go" };
const PROJ_ARCH_LABEL: Record<ProjectArchitecture, string> = { hexagonal: "Hexagonal", clean: "Clean", layered: "Camadas", mvc: "MVC" };
const PROJ_UI_LABEL: Record<ProjectUI, string> = {
  auto: "UI: auto",
  none: "Sem UI",
  "template-engine": "Template engine",
  "spa-react": "SPA React",
  streamlit: "Streamlit",
};
const PROJ_FW_LABEL: Record<ProjectFramework, string> = {
  auto: "Framework: auto",
  fastapi: "FastAPI",
  flask: "Flask",
  litestar: "Litestar",
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
        dispatch({ kind: "pushUser", text: "Revisar minhas alterações (git diff)." });
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
    }
  };

  // /diagrama [tema]: geração normal com prompt craftado — o diagrama nasce como PROPOSTA de arquivo
  // versionável (docs/diagramas/*.md), reusando todo o pipeline de propostas/aplicação/continuação.
  const runDiagram = (theme: string) => {
    dispatch({ kind: "pushUser", text: `[/diagrama] ${theme.trim() || "arquitetura do projeto"}` });
    post({ type: "chat/send", text: buildDiagramRequest(theme) });
    setInput("");
    if (taRef.current) taRef.current.style.height = "auto";
  };

  // /sumário projeto: documentação funcional padrão de mercado como PROPOSTA versionável
  // (docs/SUMARIO_FUNCIONAL.md) — geração normal com prompt craftado, zero protocolo novo.
  const runSummary = () => {
    dispatch({ kind: "pushUser", text: "[/sumário projeto] Gerar a documentação funcional do projeto." });
    post({ type: "chat/send", text: buildProjectSummaryRequest() });
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
        dispatch({ kind: "pushLocal", text: `Comando desconhecido: \`${text}\` — digite \`/\` para ver a paleta ou \`/ajuda\`.` });
      }
      return;
    }
    const withArgs = slashWithArgs(text);
    if (withArgs) {
      if (withArgs.cmd.id === "diagrama") {
        runDiagram(withArgs.args); // a cauda É o argumento (tema)
        return;
      }
      if (withArgs.cmd.id === "sumario" && normalizeSlash(withArgs.args) === "projeto") {
        runSummary(); // só a forma completa "/sumário projeto" executa
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
      const uiTag = ui !== "auto" ? `/${PROJ_UI_LABEL[ui]}` : "";
      const fwTag = framework !== "auto" ? `/${PROJ_FW_LABEL[framework]}` : "";
      dispatch({ kind: "pushUser", text: `[Projeto · ${PROJ_LANG_LABEL[language]}/${PROJ_ARCH_LABEL[architecture]}${fwTag}${uiTag}] ${text}` });
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

  // Submissão unificada: Enter e o botão Enviar fazem O MESMO — com popover aberto, executa o item
  // selecionado; senão, send(). Divergir os dois confundia (Enter rodava /limpar, botão dava "typo").
  const submit = () => {
    if (slashOpen) {
      runSlash(slashMatches[Math.min(slashSel, slashMatches.length - 1)]);
      return;
    }
    send();
  };

  const onKey = (e: React.KeyboardEvent) => {
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
            <span className="dot" style={{ background: "#3fb950" }} /> Licença ativa
          </span>
          <div className="spacer" />
          {forge.observability.traceActive && (
            <span
              className="chip"
              style={{ color: "#6f8fb0" }}
              title={`Observabilidade ativa · registrado como "${forge.identity.email ?? forge.observability.login}" no Langfuse (gerido pelo admin)`}
            >
              <Icon name="activity" size={13} /> trace
            </span>
          )}
          <button
            className="icon-btn"
            title="Revisar alterações (IA in-network)"
            onClick={() => {
              dispatch({ kind: "pushUser", text: "Revisar minhas alterações (git diff)." });
              post({ type: "review/changes" });
            }}
          >
            <Icon name="list-check" size={15} />
          </button>
          <button
            className="icon-btn"
            title="Nova conversa (limpa também o histórico e os anexos enviados ao modelo)"
            onClick={() => {
              // Mesmo efeito do /limpar: sem o chat/clear o host seguia reenviando o histórico
              // antigo — a conversa "nova" era silenciosamente contaminada (bugfix).
              dispatch({ kind: "newConversation" });
              post({ type: "chat/clear" });
            }}
          >
            <Icon name="history" size={15} />
          </button>
          <button className="icon-btn" title="Configurações" onClick={() => post({ type: "provider/openSettings" })}>
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
              <div style={{ marginTop: 12, color: "#9a9a9a", fontSize: 13 }}>Pronto para gerar.</div>
              <div style={{ marginTop: 6 }}>
                Descreva a tarefa — ex.: "Limpe o churn.parquet: remova duplicados, ajuste tipos e trate nulos com segurança."
              </div>
              <div style={{ marginTop: 14, fontSize: 11, color: "#6f6f6f" }}>
                {enabledSkills} skills ativas · {enabledMcp.length} MCP in-network
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
              <Icon name="paperclip" size={13} /> Contexto: editor ativo · {enabledSkills} skills habilitadas
            </div>
            {enabledMcp.length > 0 && (
              <div className="ctx-row">
                <Icon name="plug" size={13} color="#8aa0b8" /> MCP: {enabledMcp.map((m) => m.id).join(", ")}
                <span className="chip" style={{ color: "#6f8fb0" }}>
                  <Icon name="network" size={12} /> rede interna
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
                <Icon name="code" size={14} /> Anexar seleção do editor
              </button>
              <button onClick={() => { setAttachMenu(false); post({ type: "context/addTerminalSelection" }); }}>
                <Icon name="terminal" size={14} /> Anexar seleção do terminal
              </button>
              <button onClick={() => { setAttachMenu(false); post({ type: "context/pickWorkspaceFile" }); }}>
                <Icon name="paperclip" size={14} /> Anexar arquivo do workspace
              </button>
              <button onClick={() => { setAttachMenu(false); post({ type: "context/pickLocalFile" }); }}>
                <Icon name="arrow-up" size={14} /> Enviar do computador
              </button>
              {forge.search.enabled ? (
                <button onClick={() => { setAttachMenu(false); post({ type: "context/search" }); }}>
                  <Icon name="search" size={14} color="#86c98e" /> {forge.search.label}
                </button>
              ) : (
                <button className="disabled" onClick={() => { setAttachMenu(false); post({ type: "context/webInfo" }); }}>
                  <Icon name="network" size={14} /> Buscar na web · bloqueada (rede interna)
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
                  <span className="slash-label">{c.label}</span>
                  <span className="slash-hint">{c.hint}</span>
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
            placeholder="Pergunte ou descreva a tarefa…"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = Math.min(e.target.scrollHeight, 140) + "px";
            }}
            onKeyDown={onKey}
            onPaste={onPaste}
            onBlur={() => setSlashDismissed(true)} // clique fora fecha o popover (itens usam
            onFocus={() => setSlashDismissed(false)} // mouseDown+preventDefault e não disparam blur)
            rows={1}
          />
          <div className="composer-tools">
            <span className="pill" title="Anexar contexto (arquivo, seleção, upload)" onClick={() => setAttachMenu((v) => !v)}>
              <Icon name="paperclip" size={15} />
            </span>
            <span
              className="pill"
              title="Modo Projeto: gera um projeto COMPLETO na linguagem e arquitetura escolhidas"
              onClick={() => {
                setProjectMode((v) => !v);
                setTdd(false);
              }}
              style={{ color: projectMode ? "#e0863c" : undefined, fontWeight: projectMode ? 500 : undefined }}
            >
              <Icon name={projectMode ? "circle-check" : "circle"} size={14} color={projectMode ? "#e0863c" : undefined} /> Projeto
            </span>
            <span
              className="pill"
              title="Modo TDD: escreve o teste primeiro, depois a implementação"
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
                  title="Linguagem"
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
                <select className="proj-select" title="Arquitetura" value={architecture} onChange={(e) => setArchitecture(e.target.value as ProjectArchitecture)}>
                  {PROJECT_ARCHITECTURES.map((a) => (
                    <option key={a} value={a}>
                      {PROJ_ARCH_LABEL[a]}
                    </option>
                  ))}
                </select>
                <select
                  className="proj-select"
                  title="Camada de UI do projeto (opcional): auto deixa o modelo decidir; as demais viram instrução explícita no blueprint e na geração"
                  value={projUi}
                  onChange={(e) => setProjUi(e.target.value as ProjectUI)}
                >
                  {PROJECT_UIS.filter((u) => u !== "streamlit" || language === "python").map((u) => (
                    <option key={u} value={u}>
                      {PROJ_UI_LABEL[u]}
                    </option>
                  ))}
                </select>
                {language === "python" && (
                  <select
                    className="proj-select"
                    title="Framework web do projeto Python (opcional): auto deixa o modelo decidir; FastAPI, Flask ou Litestar viram instrução explícita"
                    value={projFw}
                    onChange={(e) => setProjFw(e.target.value as ProjectFramework)}
                  >
                    {PROJECT_FRAMEWORKS.map((f) => (
                      <option key={f} value={f}>
                        {PROJ_FW_LABEL[f]}
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
                title="Parar"
                style={{ background: "#3a3a3a", color: "#ddd" }}
                onClick={() => {
                  const last = [...state.messages].reverse().find((x) => x.role === "assistant" && x.streaming);
                  if (last) post({ type: "chat/abort", taskId: last.id });
                }}
              >
                <Icon name="x" size={15} />
              </button>
            ) : (
              <button className="send-btn" title="Enviar" onClick={submit} disabled={!input.trim()}>
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
          <Icon name="shield-check" size={13} /> Licença ✓
        </div>
        {forge.observability.traceActive && (
          <div className="sb-item" style={{ color: "#7bbf6a" }} title={`Telemetria ativa · usuário "${forge.identity.email ?? forge.observability.login}"`}>
            <Icon name="activity" size={13} /> trace ✓
          </div>
        )}
        {forge.network.internalOnly && (
          <div className="sb-item" style={{ color: "#8aa0b8" }}>
            <Icon name="network" size={13} /> rede interna
          </div>
        )}
        {forge.rag.enabled && (
          <div
            className="sb-item"
            style={{ color: !forge.rag.ready ? "#9a9a9a" : forge.rag.mode === "embeddings" ? "#7bbf6a" : "#b0a070" }}
            title={
              !forge.rag.ready
                ? "Indexando o codebase…"
                : forge.rag.mode === "embeddings"
                ? `Busca semântica · ${forge.rag.embeddingModel} · ${forge.rag.files} arquivos`
                : `BM25 lexical (sem embeddings) · ${forge.rag.files} arquivos`
            }
          >
            <Icon name="database" size={13} className={!forge.rag.ready ? "spin" : ""} />
            {!forge.rag.ready ? "RAG indexando…" : `RAG ${forge.rag.mode === "embeddings" ? "embeddings" : "lexical"} · ${forge.rag.chunks}`}
          </div>
        )}
        <div className="spacer" />
        {forge.provider.supportsReasoningEffort && (
          <button
            className="sb-item sb-btn"
            title="Esforço de raciocínio do gpt-oss — clique para alternar (baixo → médio → alto). Esforço maior raciocina mais e eleva o timeout automaticamente."
            onClick={() => {
              const cur = forge.provider.reasoningEffort ?? DEFAULT_REASONING_EFFORT;
              const next = REASONING_EFFORTS[(REASONING_EFFORTS.indexOf(cur) + 1) % REASONING_EFFORTS.length];
              post({ type: "provider/setEffort", effort: next });
            }}
          >
            <Icon name="cpu" size={13} /> esforço: {EFFORT_LABEL[forge.provider.reasoningEffort ?? DEFAULT_REASONING_EFFORT]}
          </button>
        )}
        {forge.provider.configured && (
          <button
            className="sb-item sb-btn"
            title="Máximo de tokens de saída — clique para alternar (auto → 16k → 32k → 64k → 128k). Valores altos são rebaixados automaticamente ao que o gateway serve (sem erro)."
            onClick={() => {
              const cur = forge.provider.maxOutput ?? 0;
              const idx = MAX_OUTPUT_PRESETS.indexOf(cur);
              const next = MAX_OUTPUT_PRESETS[(idx < 0 ? 0 : idx + 1) % MAX_OUTPUT_PRESETS.length];
              post({ type: "provider/setMaxOutput", maxTokens: next });
            }}
          >
            <Icon name="activity" size={13} /> saída: {maxOutputLabel(forge.provider.maxOutput)}
          </button>
        )}
        <div className="sb-item" style={{ color: "#9a9a9a" }}>
          timeout {forge.provider.timeoutSeconds ?? effectiveTimeoutSeconds(forge.provider.reasoningEffort)}s
        </div>
        {state.usage && (
          <div
            className="sb-item"
            style={{ color: "#9a9a9a" }}
            title={`Tokens da sessão — entrada: ${state.usage.sessionIn} · saída: ${state.usage.sessionOut} (última geração: ${state.usage.lastIn}/${state.usage.lastOut}). Digite /tokens para o detalhe.`}
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
const STATUS_LABEL: Record<ProjectFileStatus, string> = {
  pending: "pendente",
  generating: "gerando…",
  complete: "gerado",
  applied: "aplicado",
  failed: "não gerado",
};

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
          <Icon name="list-check" size={15} color="#e0863c" /> Blueprint do projeto
          {bp ? <span className="plan-sub">· {bp.files.length} arquivos</span> : null}
          <div className="spacer" />
          {!proj.busy && (
            <span className="icon-btn" title="Fechar" onClick={close}>
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
                  Fechar
                </button>
                <button className="btn p" disabled={!proj.brief} onClick={retry}>
                  <Icon name="refresh" size={13} /> Tentar de novo
                </button>
              </div>
            </>
          ) : (
            <div className="profile-empty">
              <Icon name="refresh" size={13} className="spin" /> {proj.planStep ?? "Planejando o projeto…"}
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
            <div className="plan-hint">
              {proj.done
                ? "Arquivos gerados. Clique em “Aplicar tudo” para gravá-los no workspace, ou feche para revisar antes."
                : "Revise os arquivos abaixo — passe o mouse para ver o objetivo e as dependências de cada um. “Aprovar e gerar” cria todos na ordem de dependência; “Cancelar” descarta o plano."}
            </div>
            {gate && (
              // Veredito do gate: reprovado (vermelho) · parcial/consultivo = coerência NÃO verificada
              // (âmbar, NÃO verde) · verde só quando compileall E mypy rodaram sem erro de contrato.
              <div
                className="assistant-warning"
                style={{ marginTop: 4, borderColor: gateErrors.size || gate.projectErrors.length ? "#d16969" : gate.advisory || gate.partial ? "#d1a13a" : "#86c98e" }}
              >
                <Icon name={gateErrors.size || gate.projectErrors.length || gate.advisory || gate.partial ? "alert-triangle" : "check"} size={14} /> {gate.summary}
                {gate.projectErrors.map((e, i) => (
                  <div key={i} className="mono" style={{ marginTop: 4, fontSize: 11, color: "#d16969", whiteSpace: "pre-wrap" }}>
                    {e}
                  </div>
                ))}
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
                    title={`${f.path}\n\n${f.purpose || "(sem descrição)"}${f.deps.length ? `\n\nDepende de: ${f.deps.join(", ")}` : ""}${blocked ? `\n\nGate reprovou:\n${errs.join("\n")}` : ""}`}
                  >
                    <span className="dot" style={{ background: blocked ? STATUS_DOT.failed : STATUS_DOT[f.status] }} title={blocked ? "gate reprovou" : STATUS_LABEL[f.status]} />
                    <div className="plan-file">
                      <span className="mono">{f.path}</span>
                      <span className="purpose">{blocked ? errs[0] : f.purpose}</span>
                    </div>
                    <span className="plan-st" style={{ color: blocked ? STATUS_DOT.failed : STATUS_DOT[f.status] }}>
                      {blocked ? "bloqueado" : STATUS_LABEL[f.status]}
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="actions" style={{ marginTop: 12, justifyContent: "flex-end", gap: 8 }}>
              {!proj.done ? (
                <>
                  <button className="btn" disabled={proj.busy} onClick={() => { post({ type: "project/cancel" }); close(); }}>
                    Cancelar
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
                        <Icon name="refresh" size={13} className="spin" /> gerando…
                      </>
                    ) : (
                      <>
                        <Icon name="check" size={13} /> Aprovar e gerar
                      </>
                    )}
                  </button>
                </>
              ) : (
                <>
                  <button className="btn" onClick={close}>
                    Fechar
                  </button>
                  <button className="btn p" disabled={!anyComplete} title="Aplicar todos os arquivos gerados, na ordem de dependência" onClick={() => post({ type: "proposal/applyAll" })}>
                    <Icon name="check" size={13} /> Aplicar tudo
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
          <Icon name="database" size={15} color="#7fb3d5" /> Índice · o que o FORGE injeta
          <div className="spacer" />
          <span className="icon-btn" title="Fechar" onClick={onClose}>
            <Icon name="x" size={15} />
          </span>
        </div>

        <div className="inspect-tabs">
          <button className={`inspect-tab ${tab === "skills" ? "on" : ""}`} onClick={() => setTab("skills")}>
            <Icon name="puzzle" size={12} /> Skills {insp ? `· ${insp.skills.length}` : ""}
          </button>
          <button className={`inspect-tab ${tab === "rag" ? "on" : ""}`} onClick={() => setTab("rag")}>
            <Icon name="database" size={12} /> RAG {rag ? `· ${rag.files} arq.` : ""}
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
                  ← voltar
                </button>
                <span className="inspect-path">{insp?.skills.find((s) => s.name === selSkill)?.relFile}</span>
              </div>
              <div className="inspect-detail full">
                {body === undefined ? (
                  <div className="profile-empty">carregando…</div>
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
                <div className="profile-empty">carregando…</div>
              ) : insp.skills.length === 0 ? (
                <div className="profile-empty">nenhuma skill</div>
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
                ← voltar
              </button>
              <span className="inspect-path">{selFile}</span>
            </div>
            <div className="inspect-detail full">
              {chunks === undefined ? (
                <div className="profile-empty">carregando…</div>
              ) : (
                chunks.map((c) => (
                  <div key={c.id} className="rag-chunk">
                    <div className="rag-chunk-head">
                      L{c.startLine}–{c.endLine}
                      {c.symbol ? ` · ${c.symbol}` : ""}
                      <span className="spacer" />
                      {c.hasVector ? "vetor ✓" : "sem vetor"}
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
              <div className="profile-empty">carregando…</div>
            ) : (
              <>
                <div className="rag-status">
                  <div>
                    modo <b>{rag.mode}</b> · {rag.ready ? "pronto" : "indexando…"}
                  </div>
                  <div>
                    {rag.files} arquivos · {rag.chunks} chunks{rag.capped ? ` (teto ${rag.maxChunks})` : ""}
                  </div>
                  <div className="muted">
                    {rag.mode === "embeddings" ? `${rag.embeddingModel}${rag.dimensions ? ` · ${rag.dimensions}d` : ""}` : "BM25 lexical (sem embeddings)"}
                  </div>
                </div>
                {rag.fileList.length === 0 ? (
                  <div className="profile-empty">nada indexado</div>
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
const CHARTER_UI: { key: CharterKey; label: string; rows: number; ph: string }[] = [
  { key: "purpose", label: "Propósito", rows: 3, ph: "O que a aplicação faz, para quem e qual o valor…" },
  { key: "rules", label: "Regras do projeto", rows: 5, ph: "- sempre use type hints\n- nunca logue segredos" },
  { key: "fr", label: "Requisitos funcionais", rows: 6, ph: "- RF-01: o sistema deve autenticar via licença Ed25519" },
  { key: "nfr", label: "Requisitos não funcionais", rows: 6, ph: "- RNF-01: p95 < 200ms\n- RNF-02: LGPD — sem PII em logs" },
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
          <Icon name="sparkles" size={15} color="#c9a26d" /> Charter do projeto
          <div className="spacer" />
          <span className="icon-btn" title="Fechar" onClick={onClose}>
            <Icon name="x" size={15} />
          </span>
        </div>
        <div className="charter-hint">
          Redija com o modelo e salve — o charter vira contexto fixo (pinned) em toda geração do FORGE.
        </div>
        {!charter ? (
          <div className="profile-empty">carregando…</div>
        ) : (
          <>
            {CHARTER_UI.map((sec) => {
              const drafting = charter.drafting[sec.key];
              const note = charter.notes[sec.key];
              return (
                <div key={sec.key} className="charter-sec">
                  <div className="profile-sec" style={{ display: "flex", alignItems: "center", marginBottom: 4 }}>
                    {sec.label}
                    <div className="spacer" />
                    <button
                      className="btn"
                      disabled={drafting}
                      title="Redigir/estruturar esta seção com o modelo, a partir do que você escreveu"
                      // sections: o estado ATUAL do wizard (inclui o não salvo) — um Propósito recém-
                      // digitado ancora a redação de Regras/RF/RNF vazios sem exigir "Salvar" antes.
                      onClick={() => post({ type: "charter/draft", section: sec.key, brief: charter.sections[sec.key], sections: charter.sections })}
                    >
                      <Icon name={drafting ? "refresh" : "sparkles"} size={12} className={drafting ? "spin" : ""} />{" "}
                      {drafting ? "redigindo…" : "Redigir com IA"}
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
                    placeholder={sec.ph}
                    value={charter.sections[sec.key]}
                    disabled={drafting}
                    onChange={(e) => dispatch({ kind: "charter/edit", section: sec.key, text: e.target.value })}
                  />
                </div>
              );
            })}
            <div className="actions" style={{ marginTop: 12, justifyContent: "flex-end", gap: 8 }}>
              <button className="btn" title="Abrir o .forge/project.md cru no editor" onClick={() => post({ type: "profile/open" })}>
                <Icon name="code" size={13} /> abrir .md
              </button>
              <button
                className="btn"
                disabled={state.busy || anyDrafting || !(charter.sections.fr.trim() || charter.sections.nfr.trim())}
                title="Gerar testes de aceitação (test-first) a partir dos Requisitos Funcionais/Não Funcionais"
                onClick={() => {
                  // bolha fiel: mostra no transcript os requisitos efetivamente enviados ao modelo.
                  const reqs = [charter.sections.fr.trim(), charter.sections.nfr.trim()].filter(Boolean).join("\n\n");
                  dispatch({ kind: "pushUser", text: `Gerar testes de aceitação a partir destes requisitos:\n\n${reqs}` });
                  post({ type: "charter/genTests", fr: charter.sections.fr, nfr: charter.sections.nfr });
                  onClose();
                }}
              >
                <Icon name="terminal" size={13} /> Gerar testes
              </button>
              <button
                className="btn p"
                disabled={anyDrafting}
                onClick={() => {
                  post({ type: "charter/save", sections: charter.sections });
                  onClose(); // fecha o modal e volta à tela principal (o toast "Charter salvo…" confirma)
                }}
              >
                <Icon name="check" size={13} /> Salvar
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
    ["Linguagem", s?.language],
    ["Pacotes", s?.packaging],
    ["Lint/format", s?.lintFormat.join(", ") || undefined],
    ["Tipos", s?.types.join(", ") || undefined],
    ["Testes", s?.tests],
    ["Libs", s?.libs.slice(0, 12).join(", ") || undefined],
  ];
  const detected = stackRows.filter(([, v]) => v);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal profile-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header FIXO: fechar sem rolar (em laptop de pouca altura a caixa TODA rolava). */}
        <div className="card-title">
          <Icon name="list-check" size={15} color="#4ec9b0" /> Perfil do projeto
          <div className="spacer" />
          <span className="icon-btn" title="Fechar" onClick={onClose}>
            <Icon name="x" size={15} />
          </span>
        </div>

        {/* Miolo ROLÁVEL em grid de 2 colunas (colapsa p/ 1 em painel estreito): mais horizontal,
            menos vertical — o conteúdo respira e o scroll fica só onde precisa. */}
        <div className="profile-body">
          <div className="profile-grid">
            <div>
              <div className="profile-sec">Stack detectada · automática</div>
              {!profile ? (
                <div className="profile-empty">carregando…</div>
              ) : detected.length === 0 ? (
                <div className="profile-empty">nada detectado neste workspace</div>
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
              <div className="profile-sec">Papel</div>
              <div className="profile-row">
                <span style={{ color: profile?.role ? "#cfcfcf" : "#7a7a7a" }}>{profile?.role ?? "não definido"}</span>
                <div className="spacer" />
                <button className="btn" onClick={() => post({ type: "profile/pickRole" })}>
                  <Icon name="users" size={12} /> {profile?.role ? "Alterar" : "Definir"}
                </button>
              </div>

              <div className="profile-sec">Regras · {profile?.rules.length ?? 0}</div>
              <div className="profile-rules">
                {profile && profile.rules.length === 0 && <div className="profile-empty">nenhuma regra ainda</div>}
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
          <button className="btn" title="Abrir o .forge/project.md cru no editor" onClick={() => post({ type: "profile/open" })}>
            <Icon name="code" size={13} /> abrir .md
          </button>
          <button className="btn p" title="Redigir propósito, regras e requisitos com o modelo" onClick={onWizard}>
            <Icon name="sparkles" size={13} /> Editar com wizard
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
          <Icon name="puzzle" size={13} /> Skill aplicada · {s}
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
            {thinking ? "Raciocinando…" : "Raciocínio"}
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
          <Icon name="refresh" size={13} className="spin" /> gerando…
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
            <Icon name="file-code" size={13} color="#4ec9b0" /> {block.path || "novo arquivo…"}
          </span>
          {live ? (
            <span className="gen-pill">
              <Icon name="refresh" size={12} className="spin" /> gerando…
            </span>
          ) : (
            <span className="gen-pill" style={{ color: "var(--green-soft)" }}>
              <Icon name="check" size={12} /> pronto
            </span>
          )}
        </div>
        <pre className="preview-code" ref={codeRef}>
          {block.content}
          {live && <span className="blink">▏</span>}
        </pre>
      </div>
      <div className="actions">
        <button className="btn p" disabled title="Disponível assim que a geração concluir">
          <Icon name="check" size={13} /> Aplicar e abrir
        </button>
        <button className="btn" disabled>
          <Icon name="git-compare" size={13} /> Ver diff
        </button>
      </div>
    </div>
  );
}

function ProposalCard({ p, dispatch }: { p: ProposalVM; dispatch: React.Dispatch<Action> }): JSX.Element {
  const v = p.validation;
  const gateFailed = v && !v.running && !v.gateOk;
  const labels = v?.results.map((r) => r.label).join(" + ") || "validação";
  const skipped = v?.results.filter((r) => r.status === "skipped").map((r) => r.label) ?? [];
  const cell = p.proposal.cell;
  // Artefato renderável (.html/.svg): "executar" vira "visualizar" (abre no painel de preview).
  const renderable = !cell && isRenderablePath(p.proposal.filePath);
  const openPreview = () => post({ type: "preview/open", filePath: p.proposal.filePath, proposalId: p.proposal.id });
  const [menuOpen, setMenuOpen] = useState(false);
  const applyLabel = cell ? (cell.op === "add" ? "Inserir célula" : `Substituir célula [${cell.index}]`) : "Aplicar e abrir";

  return (
    <div>
      <div className="diff-card">
        <div className="diff-head">
          <span className="left">
            <Icon name={cell ? "terminal" : "code"} size={13} color="#4ec9b0" />{" "}
            {cell ? `célula · ${p.proposal.filePath} · ${p.proposal.summary}` : `diff · ${p.proposal.filePath}`}
          </span>
          {!cell && (
            // O detector de completude (cerca-aberta/elipse) só roda em blocos forge-file; para células
            // não há verificação, então não afirmamos completude que não checamos.
            <span
              className={`seal ${p.proposal.partial ? "partial" : "ok"}`}
              title={p.proposal.partial ? "Geração parcial — o arquivo pode estar incompleto" : "Arquivo completo (sem truncamento nem elipses)"}
            >
              {p.proposal.partial ? "⚠ parcial" : "✓ completo"}
            </span>
          )}
          <span className="diff-lang">{p.proposal.language}</span>
        </div>
        <DiffView original={p.proposal.original} modified={p.proposal.modified} />
      </div>

      {p.proposal.partial && p.status !== "applied" && (
        <div className="assistant-warning" style={{ marginTop: 4 }}>
          <Icon name="alert-triangle" size={14} /> Geração parcial — o arquivo pode estar incompleto. Peça para
          continuar ou regenerar antes de aplicar.
        </div>
      )}

      {v && (
        <div className={`validation ${v.running ? "run" : v.gateOk ? "ok" : "fail"}`}>
          <Icon name={v.running ? "refresh" : "list-check"} size={14} className={v.running ? "spin" : ""} />
          {v.running ? (
            "Validação local · executando…"
          ) : (
            <>
              Validação local · {labels}
              <span className="sep">·</span>
              <span className="gate">
                <Icon name={v.gateOk ? "shield-check" : "alert-triangle"} size={13} />
                {v.gateOk ? "gate ok" : "gate reprovado"}
              </span>
              {skipped.length > 0 && <span style={{ color: "#7a7a7a" }}>· {skipped.join(", ")} indisponível</span>}
            </>
          )}
        </div>
      )}

      {p.status === "applied" ? (
        <div className="actions">
          <div className="status-applied" style={{ marginBottom: 0 }}>
            <Icon name="check" size={13} /> {cell ? "Célula aplicada" : `Aplicado em ${p.proposal.filePath}`}
          </div>
          <div className="spacer" />
          {cell ? (
            <button className="btn" title="Executar esta célula (captura a saída)" onClick={() => post({ type: "cell/run", proposalId: p.proposal.id })}>
              <Icon name="player-play" size={12} /> Executar célula
            </button>
          ) : renderable ? (
            <button className="btn" title="Abrir o preview deste arquivo (painel ao lado)" onClick={openPreview}>
              <Icon name="eye" size={12} /> Visualizar
            </button>
          ) : p.run?.running ? (
            <button className="btn" disabled title="Execução em andamento">
              <Icon name="refresh" size={12} className="spin" /> Executando…
            </button>
          ) : (
            <button
              className="btn"
              title="Executar este arquivo no terminal (com auto-cura)"
              onClick={() => post({ type: "run/file", filePath: p.proposal.filePath, proposalId: p.proposal.id })}
            >
              <Icon name="player-play" size={12} /> {p.run ? "Reexecutar" : "Executar"}
            </button>
          )}
        </div>
      ) : p.status === "discarded" ? (
        <div className="status-discarded">Descartado.</div>
      ) : (
        <div className="actions">
          <button
            className="btn p"
            disabled={!!(v && (v.running || gateFailed))}
            title={
              gateFailed
                ? "Quality gate reprovado — corrija antes de aplicar"
                : cell
                ? "Aplicar a célula e abrir o notebook"
                : "Gravar o arquivo e abri-lo no editor"
            }
            onClick={() => post({ type: "proposal/apply", proposalId: p.proposal.id })}
          >
            <Icon name="check" size={13} /> {applyLabel}
          </button>
          {!cell && (
            <button
              className="btn"
              disabled={!!(v && (v.running || gateFailed))}
              title={renderable ? "Gravar o arquivo e abrir o preview" : "Aplicar o arquivo e executá-lo no terminal"}
              onClick={() =>
                post({ type: renderable ? "proposal/applyAndPreview" : "proposal/applyAndRun", proposalId: p.proposal.id })
              }
            >
              <Icon name={renderable ? "eye" : "player-play"} size={13} /> {renderable ? "Aplicar e visualizar" : "Aplicar e executar"}
            </button>
          )}
          <button className="btn" onClick={() => post({ type: "proposal/viewDiff", proposalId: p.proposal.id })}>
            <Icon name="git-compare" size={13} /> Ver diff
          </button>
          <div className="spacer" />
          <div className="ovf">
            <button className="btn ovf-btn" title="Mais ações" onClick={() => setMenuOpen((vv) => !vv)}>
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
                    <Icon name="copy" size={13} /> Copiar conteúdo
                  </button>
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      post({ type: "proposal/discard", proposalId: p.proposal.id });
                    }}
                  >
                    <Icon name="x" size={13} /> Descartar
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

  const isTests = run.label === "testes";
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
  const title = run.label ? run.label : run.command || "execução";
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
            {run.where === "terminal" ? "no terminal" : "executando"} · {(elapsed / 1000).toFixed(1)}s
          </span>
        ) : run.skippedReason ? (
          <span>indisponível</span>
        ) : (
          <span>
            {outcome
              ? npmTests && outcome === "env-missing"
                ? "runner ausente — rode npm install"
                : testOutcomeLabel(outcome, run.exitCode)
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
          {run.skippedReason ? run.skippedReason : run.output || (running ? "iniciando…" : "(sem saída)")}
        </pre>
      )}
      {running ? (
        <div className="actions" style={{ marginTop: 7 }}>
          {run.where === "terminal" && run.runId && (
            <button className="btn" title="Focar o terminal de execução" onClick={() => post({ type: "run/focusTerminal", runId: run.runId! })}>
              <Icon name="terminal" size={12} /> Ver no terminal
            </button>
          )}
          <div className="spacer" />
          {run.runId && (
            <button className="btn" title="Interromper a execução" onClick={() => post({ type: "run/cancel", runId: run.runId! })}>
              <Icon name="x" size={12} /> Cancelar
            </button>
          )}
        </div>
      ) : (
        (canFix || envIssue || testsEnvMissing || onDismiss) && (
          <div className="actions" style={{ marginTop: 7 }}>
            {testsEnvMissing && (
              <button
                className="btn p"
                title="Instalar o pytest no venv do projeto (cria o .venv se preciso) e rodar os testes"
                onClick={() => post({ type: "tests/run" })}
              >
                <Icon name="plug" size={12} /> Instalar pytest e rodar
              </button>
            )}
            {envIssue && (
              <button
                className="btn p"
                title="Criar o venv e instalar as dependências detectadas (depois clique em Reexecutar)"
                onClick={() => post({ type: "env/prepare" })}
              >
                <Icon name="plug" size={12} /> Preparar ambiente
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
                <Icon name="refresh" size={12} /> Corrigir com FORGE
              </button>
            )}
            <div className="spacer" />
            {onDismiss && (
              <button className="btn" title="Ocultar este cartão da conversa" onClick={onDismiss}>
                <Icon name="x" size={12} /> Ocultar
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

// Cartão pós-seleção do PAPEL: mostra a linha de estilo que passa a entrar em todo prompt e as
// skills relacionadas (chips clicáveis → Índice). Substitui o toast de 5s que sumia antes de ler.
function RoleCardView({ card, onDismiss, onOpenSkill }: { card: RoleCard; onDismiss: () => void; onOpenSkill: (name: string) => void }): JSX.Element {
  return (
    <div className="role-card">
      <div className="role-card-head">
        <Icon name="users" size={14} color="#c9a26d" /> Papel definido: <b>{card.label}</b>
        <div className="spacer" />
        <span className="icon-btn" title="Dispensar" onClick={onDismiss}>
          <Icon name="x" size={13} />
        </span>
      </div>
      <div className="role-card-guidance">{card.guidance}</div>
      {card.skills.length > 0 && (
        <div className="role-card-skills">
          <span className="role-card-cap">skills relacionadas:</span>
          {card.skills.map((s) => (
            <span
              key={s.name}
              className={`role-chip${s.installed ? "" : " off"}`}
              title={s.installed ? `${s.name} · ${s.enabled ? "habilitada" : "desabilitada"} — clique para ver o SKILL.md no Índice` : `${s.name} · não instalada neste ambiente`}
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
// virar regra do projeto. Evita perguntas e tarefas longas; foca em "nunca/sempre/evite/prefira…".
function looksLikeRule(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 200 || t.includes("?")) return false;
  return /^(nunca|sempre|jamais|evite|prefira|padroniz|n[ãa]o use)\b/i.test(t);
}

// "Promover correção a regra": quando a última mensagem do usuário soa como diretiva, oferece
// salvá-la no perfil do projeto com um clique. Dismissível e nunca bloqueante.
function ProfileSuggestion({ messages }: { messages: MessageVM[] }): JSX.Element | null {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser || dismissed.has(lastUser.id)) return null;
  const rule = lastUser.text.replace(/^\[(TDD|Projeto[^\]]*)\]\s*/, "").trim();
  if (!looksLikeRule(rule)) return null;
  const close = () => setDismissed((s) => new Set(s).add(lastUser.id));
  return (
    <div className="profile-suggest">
      <Icon name="list-check" size={13} />
      <span>Salvar como regra do projeto?</span>
      <span className="rule-preview" title={rule}>“{rule.length > 60 ? rule.slice(0, 60) + "…" : rule}”</span>
      <div className="spacer" />
      <button
        className="btn p"
        onClick={() => {
          post({ type: "profile/addRule", rule });
          close();
        }}
      >
        <Icon name="check" size={12} /> Salvar
      </button>
      <button className="icon-btn" title="Dispensar" onClick={close}>
        <Icon name="x" size={13} />
      </button>
    </div>
  );
}

type DodStatus = "ok" | "fail" | "pending";

function runStatus(r: RunResultData | null): DodStatus {
  if (!r || r.skippedReason) return "pending";
  if (r.label === "testes") {
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
  const gate: DodStatus = lastApplied ? (lastApplied.validation ? (lastApplied.validation.gateOk ? "ok" : "fail") : "ok") : "pending";
  const run = runStatus(state.lastFileRun);
  const tests = runStatus(state.lastTestRun);
  const review: DodStatus = state.reviewed ? "ok" : "pending";

  const ready = applied === "ok" && gate === "ok" && tests === "ok" && review === "ok";

  const runLastApplied = () => {
    if (lastApplied) post({ type: "run/file", filePath: lastApplied.proposal.filePath, proposalId: lastApplied.proposal.id });
  };
  const doReview = () => {
    dispatch({ kind: "pushUser", text: "Revisar minhas alterações (git diff)." });
    post({ type: "review/changes" });
  };

  const items: { key: string; label: string; status: DodStatus; onClick?: () => void; title: string }[] = [
    { key: "aplicado", label: "Aplicado", status: applied, title: "Há alteração aplicada ao arquivo" },
    { key: "gate", label: "Gate", status: gate, title: "Validação local (lint/tipos) da última alteração aplicada" },
    { key: "executa", label: "Executa", status: run, onClick: runLastApplied, title: "Executar o último arquivo aplicado" },
    { key: "testes", label: "Testes", status: tests, onClick: () => post({ type: "tests/run" }), title: "Rodar a suíte de testes" },
    { key: "revisao", label: "Revisão", status: review, onClick: doReview, title: "Revisar as alterações (IA in-network)" },
  ];

  return (
    <div className={`dod ${ready ? "ready" : ""}`}>
      <span className="dod-title">
        <Icon name={ready ? "circle-check" : "list-check"} size={13} color={ready ? "#3fb950" : "#8b8b8b"} />
        {ready ? "Pronto" : "Definição de Pronto"}
      </span>
      {items.map((it) => (
        <span
          key={it.key}
          className={`dod-chip ${it.status} ${it.onClick && it.status !== "ok" ? "clickable" : ""}`}
          title={it.title}
          onClick={it.onClick && it.status !== "ok" ? it.onClick : undefined}
        >
          <Icon name={it.status === "ok" ? "check" : it.status === "fail" ? "x" : "circle"} size={11} />
          {it.label}
        </span>
      ))}
    </div>
  );
}
