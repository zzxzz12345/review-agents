import * as crypto from 'node:crypto';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { BitbucketService } from '../context/BitbucketService';
import type { BitbucketAuth, ReviewContextPack, ReviewTarget } from '../context/types';
import type {
  DiagramStackItem,
  ReviewNoteDirective,
  ReviewNoteDraft,
} from '../shared/protocol';
import { REVIEW_GIT_SCHEME, buildGitUri, parseGitUri } from './GitContentProvider';

interface StoredThread {
  draft: ReviewNoteDraft;
  thread: vscode.CommentThread;
}

export class ReviewComments {
  private readonly controller: vscode.CommentController;
  private readonly items = new Map<string, StoredThread>();

  constructor() {
    this.controller = vscode.comments.createCommentController(
      'review-agents',
      'Review Agents Drafts'
    );
    this.controller.options = {
      placeHolder: 'Add or edit review note...',
      prompt: 'Save draft review comment',
    };
  }

  public listDrafts(): ReviewNoteDraft[] {
    return Array.from(this.items.values()).map((entry) => ({ ...entry.draft }));
  }

  public clear(): void {
    for (const entry of this.items.values()) {
      entry.thread.dispose();
    }
    this.items.clear();
  }

  public addDraft(
    note: Pick<ReviewNoteDirective, 'file' | 'line' | 'severity' | 'body'>,
    target: ReviewTarget
  ): ReviewNoteDraft {
    const cleanRel = note.file.replace(/\\/g, '/').replace(/^\/+/, '');
    const lineNum = Math.max(1, note.line || 1);
    const id = crypto.randomUUID();
    const draft: ReviewNoteDraft = {
      id,
      file: cleanRel,
      line: lineNum,
      severity: note.severity,
      body: note.body.trim(),
      createdAt: new Date().toISOString(),
      published: false,
    };

    const uri = resolveCommentUri(cleanRel, target);

    const zeroLine = Math.max(0, lineNum - 1);
    const range = new vscode.Range(zeroLine, 0, zeroLine, 0);

    const comment: vscode.Comment = {
      body: new vscode.MarkdownString(`**[${draft.severity.toUpperCase()}]** ${draft.body}`),
      mode: vscode.CommentMode.Preview,
      author: { name: 'Review Agents' },
      label: 'Draft',
      timestamp: new Date(),
    };

    const thread = this.controller.createCommentThread(uri, range, [comment]);
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    thread.label = `Review Draft · ${cleanRel}:${lineNum}`;
    thread.canReply = false;

    this.items.set(id, { draft, thread });
    return { ...draft };
  }

  public removeDraft(id: string): boolean {
    const entry = this.items.get(id);
    if (!entry) {
      return false;
    }
    entry.thread.dispose();
    this.items.delete(id);
    return true;
  }

  public async publishDraftsToBitbucket(
    bitbucketService: BitbucketService,
    target: ReviewTarget,
    auth: BitbucketAuth
  ): Promise<{ publishedCount: number }> {
    if (target.kind !== 'bitbucket-pr') {
      throw new Error('Current review target is not a Bitbucket Pull Request.');
    }

    const unpublished = this.listDrafts().filter((d) => !d.published);
    if (unpublished.length === 0) {
      return { publishedCount: 0 };
    }

    const picked = await vscode.window.showQuickPick(
      unpublished.map((d) => ({
        label: `${d.file}:${d.line}`,
        description: `[${d.severity}]`,
        detail: d.body,
        picked: true,
        draft: d,
      })),
      {
        canPickMany: true,
        title: `Publish ${unpublished.length} Draft Comment(s) to Bitbucket PR #${target.pr.id}`,
        placeHolder: 'Select comments to publish to Bitbucket',
      }
    );

    if (!picked || picked.length === 0) {
      return { publishedCount: 0 };
    }

    let publishedCount = 0;
    for (const item of picked) {
      await bitbucketService.postPullRequestComment(
        target.remote,
        target.pr.id,
        auth,
        item.draft
      );
      const stored = this.items.get(item.draft.id);
      if (stored) {
        stored.draft.published = true;
        stored.thread.comments = [
          {
            body: new vscode.MarkdownString(
              `**[${stored.draft.severity.toUpperCase()}]** ${stored.draft.body}`
            ),
            mode: vscode.CommentMode.Preview,
            author: { name: 'Review Agents' },
            label: 'Published',
            timestamp: new Date(),
          },
        ];
      }
      publishedCount += 1;
    }

    return { publishedCount };
  }

  public async exportMarkdownReport(
    target: ReviewTarget,
    pack: ReviewContextPack | undefined,
    diagrams: DiagramStackItem[]
  ): Promise<vscode.TextDocument> {
    const drafts = this.listDrafts();
    const lines: string[] = [];
    if (target.kind === 'branch-explore') {
      lines.push(`# Project Review & Walkthrough Report: ${target.title}`);
      lines.push('');
      lines.push(`- **Target**: ${target.subtitle}`);
      lines.push(`- **Generated At**: ${new Date().toISOString()}`);
      if (pack?.repoOverview) {
        lines.push(
          `- **Branch**: \`${pack.repoOverview.branchName}\` (${pack.repoOverview.includedFiles} source files)`
        );
      }
      if (target.initialInstruction) {
        lines.push(`- **Instruction**: ${target.initialInstruction}`);
      }
    } else {
      lines.push(`# Code Review Report: ${target.title}`);
      lines.push('');
      lines.push(`- **Target**: ${target.subtitle}`);
      lines.push(`- **Generated At**: ${new Date().toISOString()}`);
      if (pack) {
        lines.push(
          `- **Diff Summary**: ${pack.totalFilesChanged} files changed (+${pack.totalAdditions} / -${pack.totalDeletions})`
        );
      }
    }
    lines.push('');

    if (diagrams.length > 0) {
      lines.push('## Architecture & Walkthrough Diagrams');
      lines.push('');
      for (const d of diagrams) {
        lines.push(`### ${d.title}`);
        lines.push('```mermaid');
        lines.push(d.mermaidCode.trim());
        lines.push('```');
        lines.push('');
      }
    }

    lines.push('## Review Notes & Action Items');
    lines.push('');
    if (drafts.length === 0) {
      lines.push('_No review notes recorded during this session._');
    } else {
      for (const note of drafts) {
        const status = note.published ? 'Published' : 'Draft';
        const prefix =
          note.severity === 'action'
            ? '- [ ] **[ACTION]**'
            : `- **[${note.severity.toUpperCase()}]**`;
        lines.push(`${prefix} \`${note.file}:${note.line}\` _(${status})_: ${note.body}`);
      }
    }
    lines.push('');

    const doc = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content: lines.join('\n'),
    });
    await vscode.window.showTextDocument(doc, { preview: false });
    return doc;
  }

  public dispose(): void {
    this.clear();
    this.controller.dispose();
  }
}

function resolveCommentUri(cleanRel: string, target: ReviewTarget): vscode.Uri {
  for (const ed of vscode.window.visibleTextEditors) {
    const docUri = ed.document.uri;
    if (docUri.scheme === 'file') {
      const rel = path.relative(target.repoRoot, docUri.fsPath).replace(/\\/g, '/');
      if (rel === cleanRel) {
        return docUri;
      }
    } else if (docUri.scheme === REVIEW_GIT_SCHEME) {
      const parsed = parseGitUri(docUri);
      if (
        parsed &&
        path.resolve(parsed.repoRoot) === path.resolve(target.repoRoot) &&
        parsed.relPath === cleanRel
      ) {
        return docUri;
      }
    }
  }

  const workspacePath = path.join(target.repoRoot, cleanRel);
  if (target.headRef === 'HEAD' || fsSync.existsSync(workspacePath)) {
    return vscode.Uri.file(workspacePath);
  }
  return buildGitUri(target.repoRoot, target.headRef, cleanRel);
}
