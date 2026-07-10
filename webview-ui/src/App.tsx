import React, { useEffect, useReducer } from "react";
import { DevPanel } from "./components/DevPanel";
import { Onboarding } from "./components/Onboarding";
import { Icon } from "./icons";
import { t } from "./i18n";
import { initialState, reducer } from "./state";
import { post } from "./vscode";
import type { ExtToWebview } from "./vscode";

export function App(): JSX.Element {
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    const handler = (event: MessageEvent<ExtToWebview>) => dispatch({ kind: "ext", msg: event.data });
    window.addEventListener("message", handler);
    post({ type: "ready" });
    return () => window.removeEventListener("message", handler);
  }, []);

  // Dispensa automaticamente os toasts.
  useEffect(() => {
    if (!state.toast) return;
    const id = setTimeout(() => dispatch({ kind: "clearToast" }), 5000);
    return () => clearTimeout(id);
  }, [state.toast?.seq]);

  const forge = state.forge;
  if (!forge) {
    return (
      <div className="app">
        <div className="empty">
          <Icon name="flame" size={34} color="#3a3a3a" />
          <div style={{ marginTop: 12 }}>{t("app.loading")}</div>
        </div>
      </div>
    );
  }

  const showOnboarding = forge.stage === "onboarding-license" || forge.stage === "onboarding-provider";

  return (
    <div className="app">
      {showOnboarding ? (
        <Onboarding state={state} dispatch={dispatch} />
      ) : (
        <DevPanel state={state} dispatch={dispatch} />
      )}

      {state.approval && (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="card-title">
              <Icon name="plug" size={15} color="#8aa0b8" /> {t("mcp.approve.title")}
            </div>
            <div className="card-sub">
              {t("mcp.approve.before")} <b style={{ color: "#cfcfcf" }}>{state.approval.tool}</b> {t("mcp.approve.on")}{" "}
              <b style={{ color: "#cfcfcf" }}>{state.approval.server}</b> {t("mcp.approve.scope", { scope: state.approval.scope })}
            </div>
            <div
              className="field"
              style={{ marginBottom: 12, maxHeight: 120, overflow: "auto", whiteSpace: "pre-wrap" }}
            >
              {state.approval.argsPreview}
            </div>
            <div className="actions" style={{ marginBottom: 0, justifyContent: "flex-end" }}>
              <button
                className="btn"
                onClick={() => {
                  post({ type: "mcp/approvalResponse", requestId: state.approval!.requestId, approved: false });
                  dispatch({ kind: "clearApproval" });
                }}
              >
                <Icon name="x" size={13} /> {t("common.deny")}
              </button>
              <button
                className="btn p"
                onClick={() => {
                  post({ type: "mcp/approvalResponse", requestId: state.approval!.requestId, approved: true });
                  dispatch({ kind: "clearApproval" });
                }}
              >
                <Icon name="check" size={13} /> {t("common.allow")}
              </button>
            </div>
          </div>
        </div>
      )}

      {state.toast && (
        <div className={`toast ${state.toast.level}`} onClick={() => dispatch({ kind: "clearToast" })}>
          <Icon
            name={state.toast.level === "error" ? "alert-triangle" : state.toast.level === "warn" ? "alert-triangle" : "info-circle"}
            size={15}
          />
          <span>{state.toast.message}</span>
        </div>
      )}
    </div>
  );
}
