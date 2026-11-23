import * as vscode from 'vscode';
import { GitService } from '../context/GitService';

export const REVIEW_GIT_SCHEME = 'review-git';

export function buildGitUri(repoRoot: string, ref: string, relPath: string): vscode.Uri {
  const cleanRel = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const query = new URLSearchParams({
    repo: repoRoot,
    ref,
  }).toString();

  return vscode.Uri.from({
    scheme: REVIEW_GIT_SCHEME,
    path: `/${cleanRel}`,
    query,
  });
}

export function parseGitUri(uri: vscode.Uri): {
  repoRoot: string;
  ref: string;
  relPath: string;
} | null {
  if (uri.scheme !== REVIEW_GIT_SCHEME) {
    return null;
  }
  const params = new URLSearchParams(uri.query);
  const repoRoot = params.get('repo');
  const ref = params.get('ref');
  const relPath = uri.path.replace(/^\/+/, '');
  if (!repoRoot || !ref || !relPath) {
    return null;
  }
  return { repoRoot, ref, relPath };
}

export class GitContentProvider implements vscode.TextDocumentContentProvider {
  private readonly cache = new Map<string, string>();
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  public readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(private readonly gitService: GitService) {}

  public clearCache(): void {
    this.cache.clear();
  }

  public async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const parsed = parseGitUri(uri);
    if (!parsed) {
      return '';
    }
    const cacheKey = `${parsed.repoRoot}::${parsed.ref}::${parsed.relPath}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const content = await this.gitService.getFileAtRef(
      parsed.repoRoot,
      parsed.ref,
      parsed.relPath
    );
    const result = content ?? '';
    this.cache.set(cacheKey, result);
    return result;
  }

  public dispose(): void {
    this.onDidChangeEmitter.dispose();
  }
}
