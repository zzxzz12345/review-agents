import type { HostToWebviewMessage, WebviewToHostMessage } from '../../src/shared/protocol';

interface VsCodeApi {
  postMessage(message: WebviewToHostMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
  }
}

const fallbackApi: VsCodeApi = {
  postMessage: (msg) => {
    console.debug('[ReviewAgents Webview->Host]', msg);
  },
  getState: () => undefined,
  setState: () => undefined,
};

const api: VsCodeApi =
  typeof window !== 'undefined' && typeof window.acquireVsCodeApi === 'function'
    ? window.acquireVsCodeApi()
    : fallbackApi;

export function postToHost(msg: WebviewToHostMessage): void {
  api.postMessage(msg);
}

export function onHostMessage(
  handler: (msg: HostToWebviewMessage) => void
): () => void {
  const listener = (event: MessageEvent<unknown>) => {
    if (event.data && typeof event.data === 'object') {
      handler(event.data as HostToWebviewMessage);
    }
  };
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}
