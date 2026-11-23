import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { GitService, deriveModuleGroup, matchIgnorePattern } from './GitService';
import type {
  BranchExploreTarget,
  ChapterPlan,
  FileChangeSummary,
  ReviewContextPack,
  ReviewTarget,
} from './types';

export interface ContextPackOptions {
  maxContextChars?: number;
  ignorePatterns?: string[];
  activeEditorFile?: string;
}

const BRANCH_EXPLORE_DEFAULT_IGNORES = [
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  '*.lock',
  'node_modules/**',
  '.git/**',
  'dist/**',
  'build/**',
  '*.vsix',
  '*.bin',
  '*.png',
  '*.jpg',
  '*.jpeg',
  '*.gif',
  '*.ico',
  '*.pdf',
  '*.woff',
  '*.woff2',
];

const KEY_DOC_CANDIDATES = [
  'README.md',
  'README.zh-CN.md',
  'readme.md',
  'AGENTS.md',
  'CLAUDE.md',
  'package.json',
  'pyproject.toml',
  'go.mod',
  'Cargo.toml',
  'pom.xml',
  'Makefile',
];

export class ContextPackBuilder {
  constructor(private readonly gitService: GitService) {}

  public async build(
    target: ReviewTarget,
    options: ContextPackOptions = {}
  ): Promise<ReviewContextPack> {
    if (target.kind === 'branch-explore') {
      return this.buildForBranchExplore(target, options);
    }

    const maxContextChars = options.maxContextChars ?? 24000;
    const ignorePatterns = options.ignorePatterns ?? [];

    const [rawFiles, commits] = await Promise.all([
      this.gitService.getDiffFiles(
        target.repoRoot,
        target.effectiveBaseRef,
        target.headRef,
        ignorePatterns
      ),
      this.gitService.getCommitMessages(
        target.repoRoot,
        target.effectiveBaseRef,
        target.headRef
      ),
    ]);

    const sorted = [...rawFiles].sort((a, b) => {
      if (a.isIgnored !== b.isIgnored) {
        return a.isIgnored ? 1 : -1;
      }
      const aTest = isTestFile(a.path);
      const bTest = isTestFile(b.path);
      if (aTest !== bTest) {
        return aTest ? 1 : -1;
      }
      return b.additions + b.deletions - (a.additions + a.deletions);
    });

    let remainingBudget = maxContextChars;
    const files: FileChangeSummary[] = [];
    let symbolProbeCount = 0;

    for (const file of sorted) {
      let hunkHeaders: string[] = [];
      let touchedSymbols: string[] | undefined;
      let compactDiff = '';

      if (!file.isIgnored && !file.isBinary && (remainingBudget > 300 || symbolProbeCount < 25)) {
        symbolProbeCount += 1;
        const patch = await this.gitService.getFilePatch(
          target.repoRoot,
          target.effectiveBaseRef,
          target.headRef,
          file.path,
          2
        );
        hunkHeaders = extractHunkHeaders(patch);
        const extracted = extractTouchedSymbols(patch);
        if (extracted.length > 0) {
          touchedSymbols = extracted;
        }
        if (remainingBudget > 300) {
          const strippedPatch = stripGitPatchHeader(patch);
          const perFileLimit = Math.min(2800, Math.max(400, Math.floor(remainingBudget * 0.35)));
          if (strippedPatch.length <= perFileLimit) {
            compactDiff = strippedPatch;
          } else {
            compactDiff = `${strippedPatch.slice(0, perFileLimit)}\n... [truncated, use fs/read_text_file for full context]`;
          }
          remainingBudget -= compactDiff.length;
        }
      }

      files.push({
        ...file,
        hunkHeaders,
        touchedSymbols,
        compactDiff,
      });
    }

    const clusterMap = new Map<
      string,
      {
        moduleGroup: string;
        fileCount: number;
        additions: number;
        deletions: number;
        files: string[];
      }
    >();

    for (const f of files) {
      if (f.isIgnored) {
        continue;
      }
      const existing = clusterMap.get(f.moduleGroup) ?? {
        moduleGroup: f.moduleGroup,
        fileCount: 0,
        additions: 0,
        deletions: 0,
        files: [],
      };
      existing.fileCount += 1;
      existing.additions += f.additions;
      existing.deletions += f.deletions;
      existing.files.push(f.path);
      clusterMap.set(f.moduleGroup, existing);
    }

    const moduleClusters = Array.from(clusterMap.values()).sort(
      (a, b) => b.additions + b.deletions - (a.additions + a.deletions)
    );

    const chapters = buildChapters(moduleClusters, files);

    const totalAdditions = files.reduce((acc, f) => acc + f.additions, 0);
    const totalDeletions = files.reduce((acc, f) => acc + f.deletions, 0);
    const ignoredFilesCount = files.filter((f) => f.isIgnored).length;

    return {
      target,
      generatedAt: new Date().toISOString(),
      commits,
      totalFilesChanged: files.length,
      includedFilesCount: files.length - ignoredFilesCount,
      ignoredFilesCount,
      totalAdditions,
      totalDeletions,
      files,
      chapters,
      moduleClusters,
    };
  }

  private async buildForBranchExplore(
    target: BranchExploreTarget,
    options: ContextPackOptions
  ): Promise<ReviewContextPack> {
    const [trackedFiles, commits, workingTreeChanges] = await Promise.all([
      this.gitService.listTrackedFiles(target.repoRoot, 2000),
      this.gitService.getRecentBranchCommits(target.repoRoot, 10),
      this.gitService.getWorkingTreeStatus(target.repoRoot, 30),
    ]);

    const combinedIgnores = [
      ...BRANCH_EXPLORE_DEFAULT_IGNORES,
      ...(options.ignorePatterns ?? []),
    ];

    const includedFiles: string[] = [];
    let ignoredFilesCount = 0;

    for (const filePath of trackedFiles) {
      if (matchIgnorePattern(filePath, combinedIgnores)) {
        ignoredFilesCount += 1;
        continue;
      }
      includedFiles.push(filePath);
    }

    const clusterMap = new Map<
      string,
      {
        moduleGroup: string;
        fileCount: number;
        additions: number;
        deletions: number;
        files: string[];
      }
    >();

    for (const filePath of includedFiles) {
      const moduleGroup = deriveModuleGroup(filePath);
      const existing = clusterMap.get(moduleGroup) ?? {
        moduleGroup,
        fileCount: 0,
        additions: 0,
        deletions: 0,
        files: [],
      };
      existing.fileCount += 1;
      existing.files.push(filePath);
      clusterMap.set(moduleGroup, existing);
    }

    const moduleClusters = Array.from(clusterMap.values()).sort(
      (a, b) => b.fileCount - a.fileCount || a.moduleGroup.localeCompare(b.moduleGroup)
    );

    const directorySummaries = moduleClusters.slice(0, 30).map((cluster) => {
      const sampleNames = cluster.files
        .slice(0, 8)
        .map((f) => path.posix.basename(f));
      const moreSuffix =
        cluster.files.length > 8 ? `, ... (+${cluster.files.length - 8} more)` : '';
      return `${cluster.moduleGroup} (${cluster.fileCount} files): ${sampleNames.join(', ')}${moreSuffix}`;
    });

    const keyDocs: Array<{ path: string; snippet: string }> = [];
    const seenDocLower = new Set<string>();
    let totalDocChars = 0;

    for (const candidate of KEY_DOC_CANDIDATES) {
      if (keyDocs.length >= 3 || totalDocChars >= 3500) {
        break;
      }
      const lower = candidate.toLowerCase();
      if (seenDocLower.has(lower)) {
        continue;
      }
      const fullPath = path.join(target.repoRoot, candidate);
      try {
        const raw = await fs.readFile(fullPath, 'utf8');
        seenDocLower.add(lower);
        const trimmed = raw.trim();
        if (!trimmed) {
          continue;
        }
        const remaining = 3500 - totalDocChars;
        const limit = Math.min(1200, remaining);
        const snippet =
          trimmed.length <= limit
            ? trimmed
            : `${trimmed.slice(0, limit)}\n... [truncated]`;
        keyDocs.push({ path: candidate, snippet });
        totalDocChars += snippet.length;
      } catch {
        // Ignore missing or unreadable doc candidate
      }
    }

    const chapters = buildBranchChapters(moduleClusters);

    return {
      target,
      generatedAt: new Date().toISOString(),
      commits,
      totalFilesChanged: 0,
      includedFilesCount: includedFiles.length,
      ignoredFilesCount,
      totalAdditions: 0,
      totalDeletions: 0,
      files: [],
      chapters,
      moduleClusters,
      repoOverview: {
        branchName: target.branchName,
        totalTrackedFiles: trackedFiles.length,
        includedFiles: includedFiles.length,
        ignoredFiles: ignoredFilesCount,
        directorySummaries,
        keyDocs,
        workingTreeChanges,
        activeEditorFile: options.activeEditorFile,
      },
    };
  }
}

export function formatContextPackForPrompt(
  pack: ReviewContextPack,
  maxTotalChars = 16000
): string {
  if (pack.target.kind === 'branch-explore') {
    return formatBranchExploreContextPack(pack, maxTotalChars);
  }
  const lines: string[] = [];
  lines.push(`# Review Target: ${pack.target.title}`);
  lines.push(`- Subtitle: ${pack.target.subtitle}`);
  lines.push(
    `- Diff Stats: ${pack.totalFilesChanged} files changed (+${pack.totalAdditions} / -${pack.totalDeletions}), ${pack.ignoredFilesCount} generated/lock files collapsed`
  );

  if (pack.target.kind === 'bitbucket-pr') {
    const pr = pack.target.pr;
    lines.push(`- PR #${pr.id} by ${pr.author} (${pr.sourceBranch} -> ${pr.targetBranch})`);
    if (pr.description.trim()) {
      lines.push(`\n## PR Description\n${pr.description.trim().slice(0, 1200)}`);
    }
  }

  if (pack.commits.length > 0) {
    lines.push('\n## Commits');
    for (const c of pack.commits.slice(0, 12)) {
      lines.push(`- ${c}`);
    }
  }

  lines.push('\n## Recommended Walkthrough Chapters');
  for (const ch of pack.chapters) {
    lines.push(
      `- Chapter ${ch.index}/${pack.chapters.length}: ${ch.title} (${ch.files.slice(0, 6).join(', ')})`
    );
  }

  lines.push('\n## Changed Files & Hunks');
  let runningChars = lines.join('\n').length;

  for (const f of pack.files) {
    if (f.isIgnored) {
      const line = `- [COLLAPSED] ${f.path} (+${f.additions}/-${f.deletions})`;
      lines.push(line);
      runningChars += line.length + 1;
      continue;
    }
    const renameNote = f.oldPath ? ` (from ${f.oldPath})` : '';
    const headerLines = [
      `\n### [${f.status}] ${f.path}${renameNote} (+${f.additions}/-${f.deletions})`,
    ];
    if (f.touchedSymbols && f.touchedSymbols.length > 0) {
      headerLines.push(`Classes/Methods: ${f.touchedSymbols.join(', ')}`);
    }
    if (f.hunkHeaders.length > 0) {
      headerLines.push(`Hunks: ${f.hunkHeaders.join(' | ')}`);
    }
    const headerBlock = headerLines.join('\n');
    lines.push(headerBlock);
    runningChars += headerBlock.length + 1;

    if (f.compactDiff && runningChars + f.compactDiff.length + 12 <= maxTotalChars) {
      const diffBlock = `\`\`\`diff\n${f.compactDiff}\n\`\`\``;
      lines.push(diffBlock);
      runningChars += diffBlock.length + 1;
    } else if (f.compactDiff) {
      const omitNote = '_[Diff omitted to keep initial TTFT fast; use fs/read_text_file if asked]_';
      lines.push(omitNote);
      runningChars += omitNote.length + 1;
    }
  }

  return lines.join('\n');
}

function formatBranchExploreContextPack(
  pack: ReviewContextPack,
  maxTotalChars: number
): string {
  const target = pack.target as BranchExploreTarget;
  const overview = pack.repoOverview;
  const lines: string[] = [];

  lines.push(`# Project / Branch Target: ${target.title}`);
  lines.push(`- Subtitle: ${target.subtitle}`);
  lines.push(`- Branch: ${overview?.branchName ?? target.branchName}`);
  lines.push(
    `- Repository Files: ${overview?.includedFiles ?? pack.includedFilesCount} source/project files indexed (${overview?.ignoredFiles ?? pack.ignoredFilesCount} lock/build/binary files ignored, ${overview?.totalTrackedFiles ?? pack.includedFilesCount} total tracked)`
  );

  if (overview?.activeEditorFile) {
    lines.push(`- Active Open Editor File: ${overview.activeEditorFile}`);
  }

  if (target.initialInstruction?.trim()) {
    lines.push(`\n## User Instruction\n${target.initialInstruction.trim()}`);
  }

  if (overview && overview.directorySummaries.length > 0) {
    lines.push('\n## Module & Directory Map');
    for (const summary of overview.directorySummaries) {
      lines.push(`- ${summary}`);
    }
  }

  let runningChars = lines.join('\n').length;

  if (overview && overview.keyDocs.length > 0) {
    lines.push('\n## Key Project Docs & Manifests');
    runningChars += '\n## Key Project Docs & Manifests'.length + 1;
    for (const doc of overview.keyDocs) {
      const block = `\n### ${doc.path}\n\`\`\`\n${doc.snippet}\n\`\`\``;
      if (runningChars + block.length > maxTotalChars) {
        break;
      }
      lines.push(block);
      runningChars += block.length + 1;
    }
  }

  if (pack.commits.length > 0) {
    const commitLines = ['\n## Recent Commits on Current Branch'];
    for (const c of pack.commits.slice(0, 10)) {
      commitLines.push(`- ${c}`);
    }
    const block = commitLines.join('\n');
    if (runningChars + block.length <= maxTotalChars) {
      lines.push(block);
      runningChars += block.length + 1;
    }
  }

  if (overview && overview.workingTreeChanges.length > 0) {
    const statusLines = ['\n## Local Uncommitted Changes (git status)'];
    for (const ch of overview.workingTreeChanges.slice(0, 20)) {
      statusLines.push(`- ${ch}`);
    }
    const block = statusLines.join('\n');
    if (runningChars + block.length <= maxTotalChars) {
      lines.push(block);
      runningChars += block.length + 1;
    }
  }

  lines.push(
    '\n## Inspection Guidance\n- This session inspects the current branch directly (no PR diff). Use `fs/read_text_file` selectively on the 2~5 most relevant files to verify exact class names, methods, and line numbers before jumping with `<code_goto ... view="source"/>`.'
  );

  return lines.join('\n');
}

function buildBranchChapters(
  clusters: ReviewContextPack['moduleClusters']
): ChapterPlan[] {
  const chapters: ChapterPlan[] = [
    {
      index: 1,
      title: '项目全局架构与核心模块总览',
      moduleGroup: 'overview',
      files: clusters.slice(0, 4).flatMap((c) => c.files.slice(0, 2)),
      summary: '基于当前分支的目录结构与核心入口构建 L1 全局架构视图',
    },
  ];

  const nonTestClusters = clusters.filter((c) => !isTestGroup(c.moduleGroup, c.files));
  for (const cluster of nonTestClusters.slice(0, 4)) {
    chapters.push({
      index: chapters.length + 1,
      title: `模块：${cluster.moduleGroup}`,
      moduleGroup: cluster.moduleGroup,
      files: cluster.files.slice(0, 8),
      summary: `${cluster.fileCount} 个源码文件`,
    });
  }

  return chapters;
}

function buildChapters(
  clusters: ReviewContextPack['moduleClusters'],
  files: FileChangeSummary[]
): ChapterPlan[] {
  const chapters: ChapterPlan[] = [
    {
      index: 1,
      title: '变更背景与整体架构总览',
      moduleGroup: 'overview',
      files: clusters.slice(0, 4).flatMap((c) => c.files.slice(0, 2)),
      summary: '结合白板全局图介绍此次变更解决的问题与模块间依赖关系',
    },
  ];

  const nonTestClusters = clusters.filter((c) => !isTestGroup(c.moduleGroup, c.files));
  const coreClusters = nonTestClusters.slice(0, 4);

  for (const cluster of coreClusters) {
    chapters.push({
      index: chapters.length + 1,
      title: `核心模块改动：${cluster.moduleGroup}`,
      moduleGroup: cluster.moduleGroup,
      files: cluster.files,
      summary: `${cluster.fileCount} 个文件变更 (+${cluster.additions}/-${cluster.deletions})`,
    });
  }

  const testFiles = files.filter((f) => !f.isIgnored && isTestFile(f.path)).map((f) => f.path);
  if (testFiles.length > 0) {
    chapters.push({
      index: chapters.length + 1,
      title: '测试覆盖与边界风险核查',
      moduleGroup: 'tests',
      files: testFiles,
      summary: `${testFiles.length} 个测试文件更新`,
    });
  }

  return chapters;
}

function extractHunkHeaders(patch: string): string[] {
  const headers: string[] = [];
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith('@@')) {
      headers.push(line.trim());
    }
  }
  return headers.slice(0, 8);
}

export function extractTouchedSymbols(patch: string): string[] {
  const symbols: string[] = [];
  const seen = new Set<string>();
  const addSymbol = (entry: string) => {
    if (!seen.has(entry) && symbols.length < 12) {
      seen.add(entry);
      symbols.push(entry);
    }
  };

  let headLine = 0;

  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith('@@')) {
      const hunkMatch = line.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@(?:\s+(.+))?$/);
      if (hunkMatch) {
        headLine = Number.parseInt(hunkMatch[1], 10) || 0;
        const ctx = hunkMatch[2]?.trim();
        if (ctx) {
          const parsedCtx = matchSymbolDecl(ctx);
          if (parsedCtx) {
            addSymbol(`${parsedCtx} (L${headLine})`);
          }
        }
      }
      continue;
    }

    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('diff ') || line.startsWith('index ')) {
      continue;
    }

    if (line.startsWith('-')) {
      continue;
    }

    const prefix = line[0];
    if (prefix === '+' || prefix === ' ') {
      const codeLine = line.slice(1);
      const decl = matchSymbolDecl(codeLine);
      if (decl && headLine > 0) {
        addSymbol(`${decl} (L${headLine})`);
      }
      headLine += 1;
    }
  }

  return symbols;
}

function matchSymbolDecl(rawLine: string): string | null {
  const trimmed = rawLine.trim();
  if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) {
    return null;
  }

  // Python / JS / TS / Java / Rust classes, interfaces, structs
  const typeMatch = trimmed.match(
    /^(?:export\s+(?:default\s+)?)?(?:abstract\s+)?(class|interface|struct|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/
  );
  if (typeMatch) {
    return `${typeMatch[1]} ${typeMatch[2]}`;
  }

  // Go struct / interface
  const goTypeMatch = trimmed.match(/^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(struct|interface)\b/);
  if (goTypeMatch) {
    return `${goTypeMatch[2]} ${goTypeMatch[1]}`;
  }

  // Python def / async def
  const pyDefMatch = trimmed.match(/^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
  if (pyDefMatch) {
    return `def ${pyDefMatch[1]}`;
  }

  // JS / TS function
  const tsFnMatch = trimmed.match(
    /^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*[<(]/
  );
  if (tsFnMatch) {
    return `function ${tsFnMatch[1]}`;
  }

  // TS/Java/C# class methods
  const methodMatch = trimmed.match(
    /^(?:public|private|protected|static|async|override|\s)*([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*(?::\s*[\w<>\[\]| &]+)?\s*\{/
  );
  if (
    methodMatch &&
    !['if', 'for', 'while', 'switch', 'catch', 'constructor'].includes(methodMatch[1])
  ) {
    return `method ${methodMatch[1]}`;
  }

  // Go func / Rust fn
  const goFuncMatch = trimmed.match(/^func\s+(?:\([^)]+\)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
  if (goFuncMatch) {
    return `func ${goFuncMatch[1]}`;
  }
  const rustFnMatch = trimmed.match(/^(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*[<(]/);
  if (rustFnMatch) {
    return `fn ${rustFnMatch[1]}`;
  }

  return null;
}

function stripGitPatchHeader(patch: string): string {
  const idx = patch.indexOf('@@');
  if (idx === -1) {
    return patch.trim();
  }
  return patch.slice(idx).trim();
}

function isTestFile(filePath: string): boolean {
  return /(^|\/)(__tests__|tests?|spec)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$/i.test(
    filePath
  );
}

function isTestGroup(group: string, files: string[]): boolean {
  if (/test|spec/i.test(group)) {
    return true;
  }
  return files.length > 0 && files.every((f) => isTestFile(f));
}
