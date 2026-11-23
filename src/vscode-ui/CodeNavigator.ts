import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ReviewTarget } from '../context/types';
import type {
  CodeGotoDirective,
  CodeViewMode,
  EditorLocationState,
  LineRange,
} from '../shared/protocol';
import { buildGitUri } from './GitContentProvider';
import { WhiteboardPanel } from './WhiteboardPanel';
import { MAX_HIGHLIGHT_LINES, clampHighlightRange } from './highlightRange';

export class CodeNavigator {
  private preferredViewMode: CodeViewMode;
  private lastLocation: EditorLocationState | undefined;
  private activeTargetUri: vscode.Uri | undefined;
  private lastProgrammaticNav: { file: string; atMs: number } | undefined;

  constructor(initialViewMode: CodeViewMode = 'source') {
    this.preferredViewMode = initialViewMode;
  }

  private readonly rangeDecorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
    isWholeLine: true,
    borderWidth: '0 0 0 3px',
    borderStyle: 'solid',
    borderColor: new vscode.ThemeColor('focusBorder'),
    overviewRulerColor: new vscode.ThemeColor('focusBorder'),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });

  private readonly labelDecorationType = vscode.window.createTextEditorDecorationType({
    after: {
      margin: '0 0 0 18px',
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
      fontStyle: 'italic',
    },
  });

  public get currentViewMode(): CodeViewMode {
    return this.preferredViewMode;
  }

  public get currentLocation(): EditorLocationState | undefined {
    return this.lastLocation;
  }

  public get currentUri(): vscode.Uri | undefined {
    return this.activeTargetUri;
  }

  public isRecentProgrammaticNavigation(relFile: string, withinMs = 600): boolean {
    if (!this.lastProgrammaticNav) {
      return false;
    }
    const clean = relFile.replace(/\\/g, '/').replace(/^\/+/, '');
    return (
      this.lastProgrammaticNav.file === clean &&
      Date.now() - this.lastProgrammaticNav.atMs <= withinMs
    );
  }

  public setViewMode(mode: CodeViewMode): void {
    this.preferredViewMode = mode;
  }

  public async toggleViewMode(
    target: ReviewTarget | undefined,
    whiteboardPanel: WhiteboardPanel
  ): Promise<CodeViewMode> {
    if (target?.kind === 'branch-explore') {
      return 'source';
    }
    this.preferredViewMode = this.preferredViewMode === 'diff' ? 'source' : 'diff';
    if (target && this.lastLocation) {
      await this.navigateTo(
        {
          type: 'code_goto',
          file: this.lastLocation.file,
          lines: this.lastLocation.lines,
          view: this.preferredViewMode,
          label: this.lastLocation.label,
        },
        target,
        whiteboardPanel
      );
    }
    return this.preferredViewMode;
  }

  public async navigateTo(
    cmd: CodeGotoDirective,
    target: ReviewTarget,
    whiteboardPanel: WhiteboardPanel,
    options?: { preferWorkspaceFile?: boolean }
  ): Promise<EditorLocationState> {
    const cleanRel = cmd.file.replace(/\\/g, '/').replace(/^\/+/, '');
    const effectiveView = cmd.view ?? this.preferredViewMode;

    whiteboardPanel.ensureSplitForCode();

    const baseUri = buildGitUri(target.repoRoot, target.effectiveBaseRef, cleanRel);
    const gitHeadUri = buildGitUri(target.repoRoot, target.headRef, cleanRel);
    const workspaceFilePath = path.join(target.repoRoot, cleanRel);
    const workspaceExists = await fileExists(workspaceFilePath);
    const headUri =
      target.headRef === 'HEAD' && workspaceExists
        ? vscode.Uri.file(workspaceFilePath)
        : gitHeadUri;

    let focusUri = headUri;

    if (effectiveView === 'diff') {
      const title = `${path.basename(cleanRel)} (${shortRef(target.baseRef)} ↔ ${shortRef(
        target.headRef
      )})`;
      await vscode.commands.executeCommand('vscode.diff', baseUri, headUri, title, {
        viewColumn: vscode.ViewColumn.One,
        preserveFocus: true,
        preview: true,
      });
      focusUri = headUri;
    } else {
      const openSourceUri = async (uri: vscode.Uri): Promise<vscode.Uri> => {
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, {
          viewColumn: vscode.ViewColumn.One,
          preserveFocus: true,
          preview: true,
        });
        return uri;
      };
      const preferWorkspace =
        Boolean(options?.preferWorkspaceFile) || target.headRef === 'HEAD';
      if (preferWorkspace && workspaceExists) {
        focusUri = await openSourceUri(vscode.Uri.file(workspaceFilePath));
      } else {
        try {
          focusUri = await openSourceUri(gitHeadUri);
        } catch (err) {
          if (!workspaceExists) {
            throw err;
          }
          focusUri = await openSourceUri(vscode.Uri.file(workspaceFilePath));
        }
      }
    }

    this.activeTargetUri = focusUri;

    const effectiveLines = cmd.lines
      ? clampHighlightRange(cmd.lines, MAX_HIGHLIGHT_LINES)
      : undefined;

    const editor = await this.findVisibleEditor(focusUri);
    if (editor && effectiveLines) {
      this.applyLineHighlight(editor, effectiveLines, cmd.label);
    } else if (editor) {
      this.clearDecorations(editor);
    }

    const location: EditorLocationState = {
      file: cleanRel,
      lines: effectiveLines,
      view: effectiveView,
      label: cmd.label,
    };
    this.lastLocation = location;
    this.lastProgrammaticNav = { file: cleanRel, atMs: Date.now() };
    return location;
  }

  public clearAllHighlights(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.clearDecorations(editor);
    }
  }

  public dispose(): void {
    this.rangeDecorationType.dispose();
    this.labelDecorationType.dispose();
  }

  private clearDecorations(editor: vscode.TextEditor): void {
    editor.setDecorations(this.rangeDecorationType, []);
    editor.setDecorations(this.labelDecorationType, []);
  }

  private applyLineHighlight(
    editor: vscode.TextEditor,
    lines: LineRange,
    label?: string
  ): void {
    const lineCount = editor.document.lineCount;
    if (lineCount === 0) {
      return;
    }
    const startLine = Math.max(0, Math.min(lineCount - 1, lines.start - 1));
    const endLine = Math.max(startLine, Math.min(lineCount - 1, lines.end - 1));
    const endCol = editor.document.lineAt(endLine).text.length;
    const range = new vscode.Range(startLine, 0, endLine, endCol);

    this.clearAllHighlights();
    editor.setDecorations(this.rangeDecorationType, [range]);

    if (label?.trim()) {
      const firstLineLen = editor.document.lineAt(startLine).text.length;
      const labelRange = new vscode.Range(startLine, firstLineLen, startLine, firstLineLen);
      editor.setDecorations(this.labelDecorationType, [
        {
          range: labelRange,
          renderOptions: {
            after: {
              contentText: ` ◀ ${label.trim()}`,
            },
          },
        },
      ]);
    }

    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  }

  private async findVisibleEditor(
    targetUri: vscode.Uri
  ): Promise<vscode.TextEditor | undefined> {
    const targetStr = targetUri.toString();
    for (let attempt = 0; attempt < 6; attempt++) {
      const found = vscode.window.visibleTextEditors.find(
        (ed) => ed.document.uri.toString() === targetStr
      );
      if (found) {
        return found;
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    return undefined;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function shortRef(ref: string): string {
  return /^[0-9a-f]{12,}$/i.test(ref) ? ref.slice(0, 7) : ref;
}
