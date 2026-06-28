import type { ExtToWebview, WebviewToExt } from "../../src/shared/protocol";

interface VsCodeApi {
  postMessage(msg: WebviewToExt): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

// O VSCode injeta acquireVsCodeApi exatamente uma vez; faz cache dela.
const api: VsCodeApi = acquireVsCodeApi();

export function post(msg: WebviewToExt): void {
  api.postMessage(msg);
}

export type { ExtToWebview, WebviewToExt };
