import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ContextPackBuilder,
  extractTouchedSymbols,
  formatContextPackForPrompt,
} from '../ContextPackBuilder';
import { GitService } from '../GitService';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout;
}

describe('GitService and ContextPackBuilder', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }))
    );
    tempDirs.length = 0;
  });

  it('builds structured ContextPack with collapsed lockfiles, module clusters, and chapters', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ra-git-test-'));
    tempDirs.push(repoDir);

    await git(repoDir, ['init', '-b', 'main']);
    await git(repoDir, ['config', 'user.email', 'test@example.com']);
    await git(repoDir, ['config', 'user.name', 'Test User']);

    await fs.mkdir(path.join(repoDir, 'src', 'auth'), { recursive: true });
    await fs.mkdir(path.join(repoDir, 'src', 'api'), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, 'src', 'auth', 'token.ts'),
      'export function verifyToken(t: string) {\n  return t.length > 0;\n}\n',
      'utf8'
    );
    await fs.writeFile(
      path.join(repoDir, 'src', 'api', 'routes.ts'),
      'export const routes = ["/health"];\n',
      'utf8'
    );
    await fs.writeFile(path.join(repoDir, 'package-lock.json'), '{"v":1}\n', 'utf8');

    await git(repoDir, ['add', '.']);
    await git(repoDir, ['commit', '-m', 'chore: initial']);

    await git(repoDir, ['checkout', '-b', 'feat/refresh-lock']);
    await fs.writeFile(
      path.join(repoDir, 'src', 'auth', 'token.ts'),
      'let refreshing = false;\nexport function verifyToken(t: string) {\n  if (refreshing) return false;\n  return t.startsWith("Bearer ");\n}\n',
      'utf8'
    );
    await fs.writeFile(
      path.join(repoDir, 'src', 'auth', 'token.test.ts'),
      'import { verifyToken } from "./token";\nconsole.log(verifyToken("Bearer x"));\n',
      'utf8'
    );
    await fs.writeFile(path.join(repoDir, 'package-lock.json'), '{"v":2}\n', 'utf8');
    await git(repoDir, ['add', '.']);
    await git(repoDir, ['commit', '-m', 'feat(auth): add refresh guard']);

    const gitService = new GitService();
    const builder = new ContextPackBuilder(gitService);
    const effectiveBaseRef = await gitService.resolveMergeBase(
      repoDir,
      'main',
      'HEAD'
    );

    const pack = await builder.build(
      {
        kind: 'local-diff',
        repoRoot: repoDir,
        baseRef: 'main',
        effectiveBaseRef,
        headRef: 'HEAD',
        title: 'feat/refresh-lock vs main',
        subtitle: 'Local Diff',
      },
      {
        maxContextChars: 12000,
        ignorePatterns: ['package-lock.json', '*.lock'],
      }
    );

    expect(pack.totalFilesChanged).toBe(3);
    expect(pack.ignoredFilesCount).toBe(1);
    expect(pack.includedFilesCount).toBe(2);
    expect(pack.moduleClusters.some((c) => c.moduleGroup === 'src/auth')).toBe(true);
    expect(pack.chapters.length).toBeGreaterThanOrEqual(2);

    const lockEntry = pack.files.find((f) => f.path === 'package-lock.json');
    expect(lockEntry?.isIgnored).toBe(true);
    expect(lockEntry?.compactDiff).toBe('');

    const tokenEntry = pack.files.find((f) => f.path === 'src/auth/token.ts');
    expect(tokenEntry?.compactDiff).toContain('verifyToken');

    const promptMd = formatContextPackForPrompt(pack);
    expect(promptMd).toContain('[COLLAPSED] package-lock.json');
    expect(promptMd).toContain('src/auth/token.ts');
    expect(promptMd).toContain('Classes/Methods: function verifyToken (L2)');

    const oldContent = await gitService.getFileAtRef(
      repoDir,
      effectiveBaseRef,
      'src/auth/token.ts'
    );
    expect(oldContent).toContain('return t.length > 0;');

    const missingOld = await gitService.getFileAtRef(
      repoDir,
      effectiveBaseRef,
      'src/auth/token.test.ts'
    );
    expect(missingOld).toBeNull();
  });

  it('extracts Python and TypeScript class/method landmarks with line numbers from unified patches', () => {
    const patch = `diff --git a/svm_risk.py b/svm_risk.py
@@ -10,2 +10,8 @@ class BaseFilter:
+class SvmRiskFilter(BaseFilter):
+    def compute_score(self, x):
+        return x
@@ -55,1 +61,5 @@
+export class TokenController {
+  async refresh(req: Request): Promise<void> {
+    return;
+  }
+}`;

    const symbols = extractTouchedSymbols(patch);
    expect(symbols).toContain('class BaseFilter (L10)');
    expect(symbols).toContain('class SvmRiskFilter (L10)');
    expect(symbols).toContain('def compute_score (L11)');
    expect(symbols).toContain('class TokenController (L61)');
    expect(symbols).toContain('method refresh (L62)');
  });

  it('builds repository overview pack for branch-explore mode without PR diff', async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ra-branch-explore-'));
    tempDirs.push(repoDir);

    await git(repoDir, ['init', '-b', 'feat/orders-v2']);
    await git(repoDir, ['config', 'user.email', 'test@example.com']);
    await git(repoDir, ['config', 'user.name', 'Test User']);

    await fs.mkdir(path.join(repoDir, 'src', 'auth'), { recursive: true });
    await fs.mkdir(path.join(repoDir, 'src', 'orders'), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, 'README.md'),
      '# Order Engine\nHandles risk checks and token verification.\n',
      'utf8'
    );
    await fs.writeFile(
      path.join(repoDir, 'package.json'),
      '{"name": "order-engine", "version": "1.0.0"}\n',
      'utf8'
    );
    await fs.writeFile(path.join(repoDir, 'package-lock.json'), '{"lockfileVersion": 3}\n', 'utf8');
    await fs.writeFile(
      path.join(repoDir, 'src', 'auth', 'token.ts'),
      'export function verifyToken(t: string) { return Boolean(t); }\n',
      'utf8'
    );
    await fs.writeFile(
      path.join(repoDir, 'src', 'orders', 'risk.ts'),
      'export function checkRisk(amount: number) { return amount < 10000; }\n',
      'utf8'
    );

    await git(repoDir, ['add', '.']);
    await git(repoDir, ['commit', '-m', 'feat: initial order engine']);

    // Uncommitted local edit should appear in workingTreeChanges
    await fs.writeFile(
      path.join(repoDir, 'src', 'orders', 'risk.ts'),
      'export function checkRisk(amount: number) { return amount <= 5000; }\n',
      'utf8'
    );

    const gitService = new GitService();
    const builder = new ContextPackBuilder(gitService);
    const branchName = await gitService.getCurrentBranch(repoDir);
    expect(branchName).toBe('feat/orders-v2');

    const pack = await builder.build(
      {
        kind: 'branch-explore',
        repoRoot: repoDir,
        branchName,
        baseRef: 'HEAD',
        effectiveBaseRef: 'HEAD',
        headRef: 'HEAD',
        title: `order-engine (${branchName})`,
        subtitle: '当前分支指令 · Review 订单风控模块',
        initialInstruction: '帮我 Review 一下 src/orders 订单风控模块的边界条件',
        startMode: 'instruction',
      },
      {
        maxContextChars: 12000,
        activeEditorFile: 'src/orders/risk.ts',
      }
    );

    expect(pack.totalFilesChanged).toBe(0);
    expect(pack.ignoredFilesCount).toBe(1); // package-lock.json
    expect(pack.includedFilesCount).toBe(4);
    expect(pack.repoOverview?.branchName).toBe('feat/orders-v2');
    expect(pack.repoOverview?.activeEditorFile).toBe('src/orders/risk.ts');
    expect(pack.repoOverview?.directorySummaries.some((s) => s.includes('src/orders'))).toBe(true);
    expect(pack.repoOverview?.keyDocs.map((d) => d.path)).toEqual(['README.md', 'package.json']);
    expect(pack.repoOverview?.workingTreeChanges.some((s) => s.includes('src/orders/risk.ts'))).toBe(
      true
    );
    expect(pack.commits[0]).toContain('feat: initial order engine');
    expect(pack.chapters[0]?.title).toContain('全局架构');

    const promptMd = formatContextPackForPrompt(pack);
    expect(promptMd).toContain('## User Instruction');
    expect(promptMd).toContain('帮我 Review 一下 src/orders 订单风控模块的边界条件');
    expect(promptMd).toContain('## Module & Directory Map');
    expect(promptMd).toContain('src/orders');
    expect(promptMd).toContain('## Key Project Docs & Manifests');
    expect(promptMd).toContain('# Order Engine');
    expect(promptMd).toContain('## Local Uncommitted Changes (git status)');
  });
});
