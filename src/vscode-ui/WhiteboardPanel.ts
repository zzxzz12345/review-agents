import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { HostToWebviewMessage, WebviewToHostMessage } from '../shared/protocol';

export class WhiteboardPanel {
  private panel: vscode.WebviewPanel | undefined;
  private ready = false;
  private isPoppedOut = false;
  private pendingMessages: HostToWebviewMessage[] = [];
  private messageHandlers = new Set<(msg: WebviewToHostMessage) => void>();
  private disposeHandlers = new Set<() => void>();

  constructor(private readonly extensionUri: vscode.Uri) {}

  public get poppedOut(): boolean {
    return this.isPoppedOut;
  }

  public get visible(): boolean {
    return Boolean(this.panel?.visible);
  }

  public openOrReveal(column: vscode.ViewColumn = vscode.ViewColumn.One): void {
    if (this.panel) {
      this.panel.reveal(column, false);
      return;
    }

    const distWebviewUri = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
    const panel = vscode.window.createWebviewPanel(
      'reviewAgents.whiteboard',
      'Review Whiteboard',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [distWebviewUri],
      }
    );

    this.panel = panel;
    this.ready = false;
    this.isPoppedOut = false;
    panel.webview.html = this.buildHtml(panel.webview, distWebviewUri);

    panel.webview.onDidReceiveMessage((raw: unknown) => {
      if (!raw || typeof raw !== 'object') {
        return;
      }
      const msg = raw as WebviewToHostMessage;
      if (msg.type === 'webview:ready') {
        this.ready = true;
        const queued = this.pendingMessages.splice(0, this.pendingMessages.length);
        for (const q of queued) {
          void panel.webview.postMessage(q);
        }
      }
      for (const handler of this.messageHandlers) {
        handler(msg);
      }
    });

    panel.onDidDispose(() => {
      this.panel = undefined;
      this.ready = false;
      this.isPoppedOut = false;
      for (const cb of this.disposeHandlers) {
        cb();
      }
    });
  }

  /**
   * Moves the whiteboard to the right split column before opening code in column 1,
   * unless it is already popped out into an auxiliary window.
   */
  public ensureSplitForCode(): void {
    if (!this.panel) {
      this.openOrReveal(vscode.ViewColumn.Two);
      return;
    }
    if (this.isPoppedOut) {
      return;
    }
    if (this.panel.viewColumn !== vscode.ViewColumn.Two) {
      this.panel.reveal(vscode.ViewColumn.Two, true);
    }
  }

  public async popOutToWindow(): Promise<void> {
    if (!this.panel) {
      this.openOrReveal(vscode.ViewColumn.One);
    }
    if (!this.panel) {
      return;
    }
    this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.One, false);
    await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
    this.isPoppedOut = true;
  }

  public postMessage(msg: HostToWebviewMessage): void {
    if (!this.panel || !this.ready) {
      this.pendingMessages.push(msg);
      if (this.pendingMessages.length > 200) {
        this.pendingMessages.shift();
      }
      return;
    }
    void this.panel.webview.postMessage(msg);
  }

  public onMessage(handler: (msg: WebviewToHostMessage) => void): vscode.Disposable {
    this.messageHandlers.add(handler);
    return new vscode.Disposable(() => {
      this.messageHandlers.delete(handler);
    });
  }

  public onDidDispose(handler: () => void): vscode.Disposable {
    this.disposeHandlers.add(handler);
    return new vscode.Disposable(() => {
      this.disposeHandlers.delete(handler);
    });
  }

  public dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
    this.pendingMessages = [];
  }

  private buildHtml(webview: vscode.Webview, distWebviewUri: vscode.Uri): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(distWebviewUri, 'assets', 'index.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(distWebviewUri, 'assets', 'index.css')
    );

    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data: blob:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}' ${webview.cspSource}`,
      `media-src ${webview.cspSource} data: blob:`,
      `connect-src ${webview.cspSource} data: blob:`,
      `font-src ${webview.cspSource} data:`,
    ].join('; ');

    return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${path.basename(this.extensionUri.fsPath)} Whiteboard</title>
    <link rel="stylesheet" href="${styleUri}" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}
