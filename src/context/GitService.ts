import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { FileChangeSummary, GitRefItem, GitRemoteItem } from './types';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 20 * 1024 * 1024;

export async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: MAX_BUFFER,
    encoding: 'utf8',
  });
  return stdout;
}

export function matchIgnorePattern(filePath: string, patterns: string[]): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  const basename = normalized.split('/').pop() ?? normalized;

  for (const rawPattern of patterns) {
    const pattern = rawPattern.trim().replace(/\\/g, '/');
    if (!pattern) {
      continue;
    }
    const regexStr = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '::DOUBLE_STAR::')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
      .replace(/::DOUBLE_STAR::/g, '.*');

    const fullRegex = new RegExp(`^${regexStr}$`);
    if (fullRegex.test(normalized) || (!pattern.includes('/') && fullRegex.test(basename))) {
      return true;
    }
  }
  return false;
}

export class GitService {
  public async getRepoRoot(cwd: string): Promise<string> {
    const out = await runGit(cwd, ['rev-parse', '--show-toplevel']);
    return out.trim();
  }

  public async getRepoRootOrFallback(
    cwd: string
  ): Promise<{ repoRoot: string; isGitRepo: boolean }> {
    try {
      const repoRoot = await this.getRepoRoot(cwd);
      return { repoRoot, isGitRepo: true };
    } catch {
      return { repoRoot: cwd, isGitRepo: false };
    }
  }

  public async listTrackedFiles(cwd: string, maxFiles = 2000): Promise<string[]> {
    try {
      const out = await runGit(cwd, [
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
      ]);
      const seen = new Set<string>();
      const files: string[] = [];
      for (const rawLine of out.split(/\r?\n/)) {
        const clean = rawLine.trim().replace(/\\/g, '/').replace(/^\.\//, '');
        if (!clean || seen.has(clean)) {
          continue;
        }
        seen.add(clean);
        files.push(clean);
        if (files.length >= maxFiles) {
          break;
        }
      }
      return files;
    } catch {
      return walkWorkspaceFiles(cwd, maxFiles);
    }
  }

  public async getRecentBranchCommits(cwd: string, limit = 10): Promise<string[]> {
    try {
      const out = await runGit(cwd, ['log', '-n', String(limit), '--format=%h %s (%an)']);
      return out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  public async getWorkingTreeStatus(cwd: string, limit = 30): Promise<string[]> {
    try {
      const out = await runGit(cwd, ['status', '--short']);
      return out
        .split(/\r?\n/)
        .map((l) => l.trimEnd())
        .filter((l) => l.trim().length > 0)
        .slice(0, limit);
    } catch {
      return [];
    }
  }

  public async getCurrentBranch(cwd: string): Promise<string> {
    try {
      const out = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
      return out.trim();
    } catch {
      return 'HEAD';
    }
  }

  public async getRemotes(cwd: string): Promise<GitRemoteItem[]> {
    const out = await runGit(cwd, ['remote', '-v']);
    const map = new Map<string, GitRemoteItem>();
    for (const line of out.split(/\r?\n/)) {
      const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
      if (!match) {
        continue;
      }
      const [, name, url, kind] = match;
      const existing = map.get(name) ?? { name, fetchUrl: '', pushUrl: '' };
      if (kind === 'fetch') {
        existing.fetchUrl = url;
      } else {
        existing.pushUrl = url;
      }
      map.set(name, existing);
    }
    return Array.from(map.values());
  }

  public async listRefs(cwd: string): Promise<GitRefItem[]> {
    const items: GitRefItem[] = [];
    try {
      const branchOut = await runGit(cwd, [
        'for-each-ref',
        '--sort=-committerdate',
        '--format=%(refname)%09%(objectname:short)%09%(subject)',
        'refs/heads',
        'refs/remotes',
      ]);
      for (const line of branchOut.split(/\r?\n/)) {
        if (!line.trim()) {
          continue;
        }
        const [refname, sha, subject] = line.split('\t');
        if (!refname || refname.endsWith('/HEAD')) {
          continue;
        }
        if (refname.startsWith('refs/heads/')) {
          items.push({
            name: refname.slice('refs/heads/'.length),
            kind: 'local-branch',
            sha,
            subject,
          });
        } else if (refname.startsWith('refs/remotes/')) {
          items.push({
            name: refname.slice('refs/remotes/'.length),
            kind: 'remote-branch',
            sha,
            subject,
          });
        }
      }
    } catch {
      // ignore on empty repo
    }

    try {
      const logOut = await runGit(cwd, [
        'log',
        '-n',
        '15',
        '--format=%h%09%s',
      ]);
      for (const line of logOut.split(/\r?\n/)) {
        if (!line.trim()) {
          continue;
        }
        const [sha, subject] = line.split('\t');
        items.push({
          name: sha,
          kind: 'commit',
          sha,
          subject,
        });
      }
    } catch {
      // ignore on empty repo
    }

    return items;
  }

  public async resolveRef(cwd: string, ref: string): Promise<string> {
    const out = await runGit(cwd, ['rev-parse', '--verify', ref]);
    return out.trim();
  }

  public async resolveMergeBase(
    cwd: string,
    baseRef: string,
    headRef: string
  ): Promise<string> {
    try {
      const out = await runGit(cwd, ['merge-base', baseRef, headRef]);
      const sha = out.trim();
      if (sha) {
        return sha;
      }
    } catch {
      // unrelated histories or tag/commit comparison
    }
    return this.resolveRef(cwd, baseRef);
  }

  public async fetchRefs(
    cwd: string,
    remoteName: string,
    refs: string[]
  ): Promise<void> {
    const cleanRefs = refs.map((r) => r.trim()).filter(Boolean);
    if (cleanRefs.length === 0) {
      return;
    }
    await runGit(cwd, ['fetch', '--no-tags', remoteName, ...cleanRefs]);
  }

  public async getFileAtRef(
    cwd: string,
    ref: string,
    relPath: string
  ): Promise<string | null> {
    const cleanPath = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
    try {
      return await runGit(cwd, ['show', `${ref}:${cleanPath}`]);
    } catch {
      return null;
    }
  }

  public async getCommitMessages(
    cwd: string,
    baseRef: string,
    headRef: string,
    limit = 30
  ): Promise<string[]> {
    try {
      const out = await runGit(cwd, [
        'log',
        `-${limit}`,
        '--format=%h %s (%an)',
        `${baseRef}..${headRef}`,
      ]);
      return out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  public async getDiffFiles(
    cwd: string,
    baseRef: string,
    headRef: string,
    ignorePatterns: string[] = []
  ): Promise<Array<Omit<FileChangeSummary, 'hunkHeaders' | 'compactDiff'>>> {
    const statusOut = await runGit(cwd, [
      'diff',
      '--name-status',
      '-M',
      baseRef,
      headRef,
    ]);
    const numstatOut = await runGit(cwd, [
      'diff',
      '--numstat',
      '-M',
      baseRef,
      headRef,
    ]);

    const statsMap = new Map<
      string,
      { additions: number; deletions: number; isBinary: boolean }
    >();

    for (const line of numstatOut.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      const parts = line.split('\t');
      if (parts.length < 3) {
        continue;
      }
      const addStr = parts[0];
      const delStr = parts[1];
      const filePath = parts[parts.length - 1];
      const isBinary = addStr === '-' || delStr === '-';
      statsMap.set(filePath, {
        additions: isBinary ? 0 : Number.parseInt(addStr, 10) || 0,
        deletions: isBinary ? 0 : Number.parseInt(delStr, 10) || 0,
        isBinary,
      });
    }

    const files: Array<Omit<FileChangeSummary, 'hunkHeaders' | 'compactDiff'>> = [];

    for (const line of statusOut.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      const parts = line.split('\t');
      const rawStatus = parts[0] ?? 'M';
      const status = (rawStatus[0] ?? 'M') as FileChangeSummary['status'];

      let filePath = parts[1] ?? '';
      let oldPath: string | undefined;
      if ((status === 'R' || status === 'C') && parts.length >= 3) {
        oldPath = parts[1];
        filePath = parts[2];
      }
      if (!filePath) {
        continue;
      }

      const stat = statsMap.get(filePath) ?? {
        additions: 0,
        deletions: 0,
        isBinary: false,
      };
      const isIgnored = matchIgnorePattern(filePath, ignorePatterns);
      const moduleGroup = deriveModuleGroup(filePath);

      files.push({
        path: filePath,
        oldPath,
        status,
        additions: stat.additions,
        deletions: stat.deletions,
        isBinary: stat.isBinary,
        isIgnored,
        moduleGroup,
      });
    }

    return files;
  }

  public async getFilePatch(
    cwd: string,
    baseRef: string,
    headRef: string,
    relPath: string,
    contextLines = 3
  ): Promise<string> {
    try {
      return await runGit(cwd, [
        'diff',
        `--unified=${contextLines}`,
        baseRef,
        headRef,
        '--',
        relPath,
      ]);
    } catch {
      return '';
    }
  }
}

export function deriveModuleGroup(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length <= 1) {
    return 'root';
  }
  if ((parts[0] === 'src' || parts[0] === 'packages' || parts[0] === 'apps') && parts.length >= 3) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0];
}

const FALLBACK_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.venv',
  '__pycache__',
  'target',
  'coverage',
]);

async function walkWorkspaceFiles(rootDir: string, maxFiles: number): Promise<string[]> {
  const files: string[] = [];

  const visit = async (dir: string, relPrefix: string): Promise<void> => {
    if (files.length >= maxFiles) {
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        break;
      }
      if (entry.isDirectory()) {
        if (FALLBACK_SKIP_DIRS.has(entry.name)) {
          continue;
        }
        const nextRel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
        await visit(path.join(dir, entry.name), nextRel);
      } else if (entry.isFile()) {
        files.push(relPrefix ? `${relPrefix}/${entry.name}` : entry.name);
      }
    }
  };

  await visit(rootDir, '');
  return files;
}
