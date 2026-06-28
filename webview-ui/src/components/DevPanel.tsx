import React, { useEffect, useRef, useState } from "react";
import { Icon } from "../icons";
import type { Action, MessageVM, ProposalVM, UIState } from "../state";
import { post } from "../vscode";
import { DiffView } from "./DiffView";

export function DevPanel({ state, dispatch }: { state: UIState; dispatch: React.Dispatch<Action> }): JSX.Element {
  const forge = state.forge!;
  const [input, setInput] = useState("");
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
    dispatch({ kind: "pushUser", text });
    post({ type: "chat/send", text });
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
          {state.messages.map((m) => (m.role === "user" ? <UserBubble key={m.id} m={m} /> : <AssistantBlock key={m.id} m={m} />))}
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

      {/* Compositor */}
      <div className="composer">
        <div className="composer-box">
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
            <Icon name="paperclip" size={15} />
            <span className="pill" title="Skills habilitadas">
              <Icon name="puzzle" size={14} color="#e0a85a" /> Skills
            </span>
            <span className="pill" title="MCP in-network">
              <Icon name="plug" size={14} color="#8aa0b8" /> MCP
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
        <div className="sb-item" style={{ color: "#9a9a9a" }}>
          timeout {forge.provider.timeoutSeconds ?? 300}s
        </div>
      </div>
    </div>
  );
}

function UserBubble({ m }: { m: MessageVM }): JSX.Element {
  return <div className="user-msg">{m.text}</div>;
}

function AssistantBlock({ m }: { m: MessageVM }): JSX.Element {
  return (
    <div className="assistant">
      {m.skills.map((s) => (
        <div key={s} className="skill-badge">
          <Icon name="puzzle" size={13} /> Skill aplicada · {s}
        </div>
      ))}
      {m.reasoning && (
        <div className="reasoning">
          {m.reasoning}
          {m.streaming && <span className="blink">▏</span>}
        </div>
      )}
      {m.text && (
        <div className="assistant-text">
          {m.text}
          {m.streaming && !m.proposals.length && <span className="blink">▏</span>}
        </div>
      )}
      {!m.text && !m.reasoning && m.streaming && (
        <div className="assistant-text" style={{ color: "#7a7a7a" }}>
          <Icon name="refresh" size={13} className="spin" /> gerando…
        </div>
      )}
      {m.proposals.map((p) => (
        <ProposalCard key={p.proposal.id} p={p} />
      ))}
      {m.error && (
        <div className="validation fail" style={{ marginTop: 4 }}>
          <Icon name="alert-triangle" size={14} /> {m.error}
        </div>
      )}
    </div>
  );
}

function ProposalCard({ p }: { p: ProposalVM }): JSX.Element {
  const v = p.validation;
  const gateFailed = v && !v.running && !v.gateOk;
  const labels = v?.results.map((r) => r.label).join(" + ") || "validação";
  const skipped = v?.results.filter((r) => r.status === "skipped").map((r) => r.label) ?? [];

  return (
    <div>
      <div className="diff-card">
        <div className="diff-head">
          <span className="left">
            <Icon name="code" size={13} color="#4ec9b0" /> diff · {p.proposal.filePath}
          </span>
          <Icon name="copy" size={13} />
        </div>
        <DiffView original={p.proposal.original} modified={p.proposal.modified} />
      </div>

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
        <div className="status-applied">
          <Icon name="check" size={13} /> Aplicado em {p.proposal.filePath}
        </div>
      ) : p.status === "discarded" ? (
        <div className="status-discarded">Descartado.</div>
      ) : (
        <div className="actions">
          <button
            className="btn p"
            disabled={!!(v && (v.running || gateFailed))}
            title={gateFailed ? "Quality gate reprovado — corrija antes de aplicar" : "Aplicar"}
            onClick={() => post({ type: "proposal/apply", proposalId: p.proposal.id })}
          >
            <Icon name="check" size={13} /> Aplicar
          </button>
          <button className="btn" onClick={() => post({ type: "proposal/viewDiff", proposalId: p.proposal.id })}>
            <Icon name="git-compare" size={13} /> Ver diff
          </button>
          <button className="btn" onClick={() => post({ type: "proposal/discard", proposalId: p.proposal.id })}>
            <Icon name="x" size={13} /> Descartar
          </button>
        </div>
      )}
    </div>
  );
}
