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
  ProjectArchitecture,
  ProjectLanguage,
} from "../../../src/shared/protocol";
import type { BlueprintFileView, ProjectFileStatus, RagChunkView, SkillInspectView } from "../../../src/shared/protocol";
import { pytestOutcome, TestOutcome, testOutcomeLabel } from "../../../src/util/testOutcome";
import { DiffView } from "./DiffView";
import { Markdown } from "./Markdown";
import { DEFAULT_REASONING_EFFORT, effectiveTimeoutSeconds, REASONING_EFFORTS, type ReasoningEffort } from "../../../src/shared/protocol";

const EFFORT_LABEL: Record<ReasoningEffort, string> = { low: "baixo", medium: "médio", high: "alto" };
const PROJ_LANG_LABEL: Record<ProjectLanguage, string> = { python: "Python", typescript: "TypeScript", java: "Java", go: "Go" };
const PROJ_ARCH_LABEL: Record<ProjectArchitecture, string> = { hexagonal: "Hexagonal", clean: "Clean", layered: "Camadas", mvc: "MVC" };

export function DevPanel({ state, dispatch }: { state: UIState; dispatch: React.Dispatch<Action> }): JSX.Element {
  const forge = state.forge!;
  const [input, setInput] = useState("");
  const [tdd, setTdd] = useState(false);
  const [projectMode, setProjectMode] = useState(false);
  const [language, setLanguage] = useState<ProjectLanguage>("python");
  const [architecture, setArchitecture] = useState<ProjectArchitecture>("hexagonal");
  const [attachMenu, setAttachMenu] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showCharter, setShowCharter] = useState(false);
  const [showInspect, setShowInspect] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: "smooth" });
  }, [state.messages]);

  const enabledSkills = forge.skills.filter((s) => s.enabled).length;
  const enabledMcp = forge.mcp.filter((m) => m.enabled);

  const send = () => {
    const text = input.trim();
    if (!text || state.busy) return;
    if (projectMode) {
      // Fase F: planeja um BLUEPRINT aprovável antes de gerar código.
      dispatch({ kind: "pushUser", text: `[Projeto · ${PROJ_LANG_LABEL[language]}/${PROJ_ARCH_LABEL[architecture]}] ${text}` });
      dispatch({ kind: "project/planning" });
      post({ type: "project/blueprint", text, language, architecture });
    } else {
      dispatch({ kind: "pushUser", text: tdd ? `[TDD] ${text}` : text });
      post({ type: "chat/send", text, tdd });
    }
    setInput("");
    if (taRef.current) taRef.current.style.height = "auto";
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
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
          <button className="icon-btn" title="Nova conversa" onClick={() => dispatch({ kind: "newConversation" })}>
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
        <div className="composer-box">
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
            rows={1}
          />
          <div className="composer-tools">
            <span className="pill" title="Anexar contexto (arquivo, seleção, upload)" onClick={() => setAttachMenu((v) => !v)}>
              <Icon name="paperclip" size={15} />
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
            {projectMode && (
              <>
                <select className="proj-select" title="Linguagem" value={language} onChange={(e) => setLanguage(e.target.value as ProjectLanguage)}>
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
              </>
            )}
            <span className="pill" title="Rodar a suíte de testes (pytest)" onClick={() => post({ type: "tests/run" })}>
              <Icon name="terminal" size={14} color="#86c98e" /> Testes
            </span>
            <span
              className="pill"
              title="Preparar ambiente: cria o venv e instala as dependências (requirements.txt/pyproject)"
              onClick={() => post({ type: "env/prepare" })}
            >
              <Icon name="plug" size={14} color="#c9a26d" /> Ambiente
            </span>
            <span
              className="pill"
              title="Inspecionar (read-only) as skills injetadas e o que está indexado no RAG"
              onClick={() => {
                setShowInspect(true);
                post({ type: "inspect/open" });
              }}
            >
              <Icon name="database" size={14} color="#7fb3d5" /> Índice
            </span>
            <span
              className="pill"
              title="Perfil do projeto — stack, papel e convenções"
              onClick={() => {
                dispatch({ kind: "clearProfile" }); // força "carregando…" e evita dados stale ao reabrir
                setShowProfile(true);
                post({ type: "profile/refresh" });
              }}
            >
              <Icon name="list-check" size={14} /> Perfil
            </span>
            <span className="pill" title="Definir seu papel no projeto — ajusta o estilo/defaults" onClick={() => post({ type: "profile/pickRole" })}>
              <Icon name="users" size={14} /> Papel
            </span>
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
              <button className="send-btn" title="Enviar" onClick={send} disabled={!input.trim()}>
                <Icon name="arrow-up" size={15} />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Barra de status */}
      <div className="statusbar">
        <div className="sb-item brand">
          <Icon name="flame" size={13} /> {forge.provider.label ?? forge.provider.modelId}
        </div>
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
        <div className="sb-item" style={{ color: "#9a9a9a" }}>
          timeout {forge.provider.timeoutSeconds ?? effectiveTimeoutSeconds(forge.provider.reasoningEffort)}s
        </div>
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
      {showInspect && <InspectPanel state={state} onClose={() => setShowInspect(false)} />}
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
  const close = () => dispatch({ kind: "project/close" });
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
          <div className="profile-empty">
            <Icon name="refresh" size={13} className="spin" /> Planejando o projeto…
          </div>
        ) : (
          <>
            <div className="plan-hint">Revise o plano. Ao aprovar, o FORGE gera cada arquivo na ordem de dependência.</div>
            <div className="plan-list">
              {files.map((f) => (
                <div key={f.path} className="plan-item">
                  <span className="dot" style={{ background: STATUS_DOT[f.status] }} title={STATUS_LABEL[f.status]} />
                  <div className="plan-file">
                    <span className="mono">{f.path}</span>
                    <span className="purpose">{f.purpose}</span>
                  </div>
                  <span className="plan-st" style={{ color: STATUS_DOT[f.status] }}>
                    {STATUS_LABEL[f.status]}
                  </span>
                </div>
              ))}
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
function InspectPanel({ state, onClose }: { state: UIState; onClose: () => void }): JSX.Element {
  const [tab, setTab] = useState<"skills" | "rag">("skills");
  const [selSkill, setSelSkill] = useState<string | null>(null);
  const [selFile, setSelFile] = useState<string | null>(null);
  const insp = state.inspect;
  const rag = insp?.rag;

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

        {tab === "skills" ? (
          <div className="inspect-cols">
            <div className="inspect-list">
              {!insp ? (
                <div className="profile-empty">carregando…</div>
              ) : insp.skills.length === 0 ? (
                <div className="profile-empty">nenhuma skill</div>
              ) : (
                insp.skills.map((s) => (
                  <div key={s.name} className={`inspect-item ${selSkill === s.name ? "on" : ""}`} onClick={() => openSkill(s)}>
                    <span className="dot" style={{ background: s.enabled ? "#86c98e" : "#555" }} />
                    <span className="nm">{s.name}</span>
                    <span className="src" style={{ color: srcColor[s.source] ?? "#9a9a9a" }}>
                      {s.source}
                    </span>
                  </div>
                ))
              )}
            </div>
            <div className="inspect-detail">
              {!selSkill ? (
                <div className="profile-empty">selecione uma skill para ver o SKILL.md</div>
              ) : body === undefined ? (
                <div className="profile-empty">carregando…</div>
              ) : (
                <>
                  <div className="inspect-path">{insp?.skills.find((s) => s.name === selSkill)?.relFile}</div>
                  <div className="inspect-md">
                    <Markdown text={body} />
                  </div>
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="inspect-cols">
            <div className="inspect-list">
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
                      <div key={f.relPath} className={`inspect-item ${selFile === f.relPath ? "on" : ""}`} onClick={() => openFile(f.relPath)}>
                        <span className="nm mono">{f.relPath}</span>
                        <span className="src">{f.chunks}</span>
                      </div>
                    ))
                  )}
                </>
              )}
            </div>
            <div className="inspect-detail">
              {!selFile ? (
                <div className="profile-empty">selecione um arquivo para ver os chunks indexados</div>
              ) : chunks === undefined ? (
                <div className="profile-empty">carregando…</div>
              ) : (
                <>
                  <div className="inspect-path">{selFile}</div>
                  {chunks.map((c) => (
                    <div key={c.id} className="rag-chunk">
                      <div className="rag-chunk-head">
                        L{c.startLine}–{c.endLine}
                        {c.symbol ? ` · ${c.symbol}` : ""}
                        <span className="spacer" />
                        {c.hasVector ? "vetor ✓" : "sem vetor"}
                      </div>
                      <pre className="rag-chunk-body">{c.preview}</pre>
                    </div>
                  ))}
                </>
              )}
            </div>
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
              return (
                <div key={sec.key} className="charter-sec">
                  <div className="profile-sec" style={{ display: "flex", alignItems: "center", marginBottom: 4 }}>
                    {sec.label}
                    <div className="spacer" />
                    <button
                      className="btn"
                      disabled={drafting}
                      title="Redigir/estruturar esta seção com o modelo, a partir do que você escreveu"
                      onClick={() => post({ type: "charter/draft", section: sec.key, brief: charter.sections[sec.key] })}
                    >
                      <Icon name={drafting ? "refresh" : "sparkles"} size={12} className={drafting ? "spin" : ""} />{" "}
                      {drafting ? "redigindo…" : "Redigir com IA"}
                    </button>
                  </div>
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
                onClick={() => post({ type: "charter/save", sections: charter.sections })}
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
        <div className="card-title">
          <Icon name="list-check" size={15} color="#4ec9b0" /> Perfil do projeto
          <div className="spacer" />
          <span className="icon-btn" title="Fechar" onClick={onClose}>
            <Icon name="x" size={15} />
          </span>
        </div>

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

        <div className="actions" style={{ marginTop: 12, marginBottom: 0, justifyContent: "flex-end", gap: 8 }}>
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

      {p.proposal.partial && (
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
      : outcome === "no-tests"
      ? "skip"
      : "fail"
    : run.ok
    ? "ok"
    : "fail";
  const canFix = outcome ? outcome === "failed" : status === "fail";
  const title = run.label ? run.label : run.command || "execução";
  const headIcon = running ? "refresh" : status === "ok" ? "check" : status === "skip" ? "info-circle" : isTests ? "terminal" : "alert-triangle";
  const fixText =
    outcome === "failed"
      ? `Os testes falharam:\n\`\`\`\n${run.output.slice(-2500)}\n\`\`\`\nCorrija o código para os testes passarem (sem enfraquecer os testes).`
      : `A execução de \`${run.filePath}\` falhou (exit ${run.exitCode ?? "?"}):\n\`\`\`\n${run.output.slice(-2500)}\n\`\`\`\nCorrija o arquivo.`;
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
            {outcome ? testOutcomeLabel(outcome, run.exitCode) : run.ok ? "ok" : `exit ${run.exitCode}`} · {Math.round(run.durationMs)} ms
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
        (canFix || onDismiss) && (
          <div className="actions" style={{ marginTop: 7 }}>
            {canFix && (
              <button
                className="btn p"
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
    return o === "passed" ? "ok" : o === "no-tests" ? "pending" : "fail"; // sem testes = pendente, não falha
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
