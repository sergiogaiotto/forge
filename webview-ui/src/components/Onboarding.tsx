import React, { useEffect, useMemo, useState } from "react";
import type { ProviderPreset, ProviderSetup, ProviderType } from "../../../src/shared/protocol";
import { Icon, IconName } from "../icons";
import type { Action, UIState } from "../state";
import { post } from "../vscode";

const PRESET_ICON: Record<string, IconName> = {
  openai: "circle",
  anthropic: "sparkles",
  "openai-compatible": "server-bolt",
};

function fmtExpiry(unix?: number): string {
  if (!unix) return "";
  try {
    return new Date(unix * 1000).toISOString().slice(0, 10);
  } catch {
    return "";
  }
}

export function Onboarding({ state, dispatch }: { state: UIState; dispatch: React.Dispatch<Action> }): JSX.Element {
  const forge = state.forge!;
  const licenseActive = forge.license.active;
  const [licenseKey, setLicenseKey] = useState("");
  const presets = forge.presets;
  const [presetId, setPresetId] = useState<string>(presets.find((p) => p.id === "hubgpu-120b")?.id ?? presets[0]?.id ?? "");
  const preset: ProviderPreset | undefined = useMemo(() => presets.find((p) => p.id === presetId), [presets, presetId]);

  const [baseUrl, setBaseUrl] = useState(preset?.baseUrl ?? "");
  const [modelId, setModelId] = useState(preset?.modelId ?? "");
  const [apiKey, setApiKey] = useState(preset?.apiKeyDefault ?? "");
  const [timeout, setTimeoutS] = useState(300);

  useEffect(() => {
    if (!preset) return;
    setBaseUrl(preset.baseUrl ?? "");
    setModelId(preset.modelId);
    setApiKey(preset.apiKeyDefault ?? "");
  }, [presetId]);

  const buildSetup = (): ProviderSetup => ({
    type: (preset?.type ?? "openai-compatible") as ProviderType,
    modelId,
    baseUrl: preset?.type === "anthropic" ? undefined : baseUrl,
    apiKey,
    timeoutSeconds: timeout,
  });

  const submitLicense = () => {
    if (licenseKey.trim()) post({ type: "license/submit", key: licenseKey.trim() });
  };

  return (
    <div className="ob">
      {/* Cabeçalho */}
      <div className="hdr">
        <div className="hdr-row">
          <Icon name="flame" size={17} color="#e0863c" />
          <span className="hdr-title">FORGE</span>
          <span style={{ fontSize: 11, color: "#8b8b8b" }}>· configuração inicial</span>
          <div className="spacer" />
          <span className="chip" style={{ color: "#8aa0b8", border: "1px solid #34465a", borderRadius: 5, padding: "2px 7px" }}>
            <Icon name="network" size={12} /> rede interna
          </span>
        </div>
        <div className="ob-steps">
          <span className={`ob-step ${licenseActive ? "done" : "active"}`}>
            <span className="num">{licenseActive ? <Icon name="check" size={12} color="#3fb950" /> : "1"}</span>
            Licença
          </span>
          <span className="ob-line" />
          <span className={`ob-step ${licenseActive ? "active" : "todo"}`}>
            <span className="num">2</span>
            Provedor
          </span>
        </div>
      </div>

      {/* Corpo */}
      <div className="body" style={{ padding: 16 }}>
        {/* Cartão de licença */}
        <div className="card">
          <div className="card-title">
            <Icon name="key" size={15} color="#8b8b8b" /> Ativar licença
          </div>
          <div className="card-sub">
            Cole a chave fornecida pelo admin. A assinatura é verificada localmente (Ed25519) e confirmada no servidor.
          </div>
          {licenseActive ? (
            <div className="ok-note">
              <Icon name="shield-check" size={14} /> Assinatura válida · org {forge.license.org ?? "—"} · expira em{" "}
              {fmtExpiry(forge.license.expiry) || "—"}
            </div>
          ) : (
            <>
              <input
                className="field"
                placeholder="FORGE-eyJzdWIiOiJkZXZAY2xhcm8i…"
                value={licenseKey}
                onChange={(e) => setLicenseKey(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submitLicense()}
                spellCheck={false}
                style={{ color: "#9cdcfe" }}
              />
              <div className="actions" style={{ marginTop: 11, marginBottom: 0, justifyContent: "flex-end" }}>
                <button className="btn p" onClick={submitLicense} disabled={!licenseKey.trim()}>
                  <Icon name="shield-check" size={13} /> Verificar e ativar
                </button>
              </div>
            </>
          )}
        </div>

        {/* Cartão de provedor */}
        <div className="card" style={{ opacity: licenseActive ? 1 : 0.55, pointerEvents: licenseActive ? "auto" : "none" }}>
          <div className="card-title">
            <Icon name="server-bolt" size={15} color="#8b8b8b" /> Escolher provedor
          </div>
          <div className="card-sub">Selecione o backend de modelo. O HubGPU usa o endpoint OpenAI-compatible.</div>

          <div style={{ display: "flex", flexDirection: "column", gap: 7, marginBottom: 13 }}>
            {presets.map((p) => (
              <div key={p.id} className={`opt ${presetId === p.id ? "sel" : ""}`} onClick={() => setPresetId(p.id)}>
                <Icon name={PRESET_ICON[p.type] ?? "server-bolt"} size={16} color={presetId === p.id ? "#e0863c" : undefined} />
                {p.label}
                <div className="spacer" />
                <Icon name={presetId === p.id ? "circle-check" : "circle"} size={15} color={presetId === p.id ? "#e0863c" : "#555"} />
              </div>
            ))}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {preset?.type !== "anthropic" && (
              <div>
                <div className="label">Base URL</div>
                <input className="field" style={{ color: "#9cdcfe" }} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} spellCheck={false} />
              </div>
            )}
            <div style={{ display: "flex", gap: 10 }}>
              <div style={{ flex: 1.4 }}>
                <div className="label">Modelo</div>
                <input className="field" value={modelId} onChange={(e) => setModelId(e.target.value)} spellCheck={false} />
              </div>
              <div style={{ flex: 1 }}>
                <div className="label">Timeout (s)</div>
                <input
                  className="field"
                  type="number"
                  value={timeout}
                  onChange={(e) => setTimeoutS(parseInt(e.target.value || "300", 10))}
                />
              </div>
            </div>
            <div>
              <div className="label">API Key</div>
              <input className="field" style={{ color: "#8b8b8b" }} value={apiKey} onChange={(e) => setApiKey(e.target.value)} spellCheck={false} />
              {preset?.note && (
                <div className="muted-note">
                  <Icon name="info-circle" size={12} /> {preset.note}
                </div>
              )}
            </div>
          </div>

          {state.providerTest && !state.providerTest.pending && (
            <div className={state.providerTest.ok ? "ok-note" : "err-note"}>
              <Icon name={state.providerTest.ok ? "shield-check" : "alert-triangle"} size={14} />
              {state.providerTest.ok
                ? `Conexão OK${state.providerTest.latencyMs ? ` · ${state.providerTest.latencyMs} ms` : ""}`
                : `Falha: ${state.providerTest.message}`}
            </div>
          )}

          <div className="actions" style={{ marginTop: 14, marginBottom: 0, justifyContent: "flex-end" }}>
            <button
              className="btn"
              onClick={() => {
                dispatch({ kind: "providerTestPending" });
                post({ type: "provider/test", setup: buildSetup() });
              }}
            >
              <Icon name={state.providerTest?.pending ? "refresh" : "plug"} size={13} className={state.providerTest?.pending ? "spin" : ""} />{" "}
              Testar conexão
            </button>
            <button className="btn p" onClick={() => post({ type: "provider/setup", setup: buildSetup() })} disabled={!modelId.trim()}>
              <Icon name="check" size={13} /> Concluir configuração
            </button>
          </div>
        </div>

        {/* Card de Embeddings (RAG) — espelha o "Testar" do hub interno */}
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-title">
            <Icon name="database" size={15} color="#8b8b8b" /> Embeddings (RAG)
          </div>
          <div className="card-sub">
            Busca semântica do codebase. O sufixo <span className="mono-inline">/embeddings</span> é adicionado pelo client —
            configure só a base.
          </div>
          {forge.rag.embeddingsUrl ? (
            <>
              <div className="label">Endpoint</div>
              <div className="field" style={{ color: "#9cdcfe" }}>
                {forge.rag.embeddingsUrl}
              </div>
              <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                <div style={{ flex: 1.6 }}>
                  <div className="label">Modelo</div>
                  <div className="field">{forge.rag.embeddingModel}</div>
                </div>
                <div style={{ flex: 1 }}>
                  <div className="label">Densidade</div>
                  <div className="field">{forge.rag.dimensions > 0 ? forge.rag.dimensions : "padrão (1024)"}</div>
                </div>
              </div>
            </>
          ) : (
            <div className="muted-note">
              <Icon name="info-circle" size={12} /> Sem endpoint — recuperação lexical (BM25), 100% offline.
            </div>
          )}

          {state.embeddingsTest && !state.embeddingsTest.pending && (
            <div className={state.embeddingsTest.ok ? "ok-note" : "err-note"}>
              <Icon name={state.embeddingsTest.ok ? "shield-check" : "alert-triangle"} size={14} />
              {state.embeddingsTest.ok
                ? state.embeddingsTest.mode === "embeddings"
                  ? `Embeddings OK · ${state.embeddingsTest.dims} dims${state.embeddingsTest.latencyMs ? ` · ${state.embeddingsTest.latencyMs} ms` : ""}`
                  : state.embeddingsTest.message
                : `Falha: ${state.embeddingsTest.message}`}
            </div>
          )}

          <div className="actions" style={{ marginTop: 12, marginBottom: 0, justifyContent: "flex-end" }}>
            <button
              className="btn"
              onClick={() => {
                dispatch({ kind: "embeddingsTestPending" });
                post({ type: "embeddings/test" });
              }}
            >
              <Icon
                name={state.embeddingsTest?.pending ? "refresh" : "plug"}
                size={13}
                className={state.embeddingsTest?.pending ? "spin" : ""}
              />{" "}
              Testar embedding
            </button>
          </div>
        </div>
      </div>

      {/* Notas do rodapé */}
      <div className="ob-foot">
        <div className="ob-foot-row">
          <Icon name="users" size={14} color="#8aa0b8" /> Observabilidade, skills e catálogo de MCP são geridos pelo admin.
        </div>
        <div className="ob-foot-row">
          <Icon name="network" size={14} color="#8aa0b8" /> Implantação em rede interna — sem conexão externa.
        </div>
        <div className="ob-foot-row">
          <Icon name="lock" size={14} /> Licença e credenciais ficam no SecretStorage. Nada em settings.json.
        </div>
      </div>

      {/* Barra de status */}
      <div className="statusbar">
        <div className="sb-item" style={{ background: "#3a3a3a", color: "#d8d8d8" }}>
          <Icon name="flame" size={13} /> FORGE · configurar
        </div>
        <div className="sb-item" style={{ color: licenseActive ? "#7bbf6a" : "#9a9a9a" }}>
          <Icon name="shield-check" size={13} /> Licença {licenseActive ? "✓" : "…"}
        </div>
        <div className="sb-item" style={{ color: "#9a9a9a" }}>
          <Icon name="server-bolt" size={13} /> Provedor: definindo…
        </div>
        <div className="sb-item" style={{ color: "#8aa0b8" }}>
          <Icon name="network" size={13} /> rede interna
        </div>
      </div>
    </div>
  );
}
