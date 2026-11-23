export interface BitbucketRemoteInfo {
  kind: 'cloud' | 'server';
  remoteName: string;
  baseUrl: string;
  workspaceOrProject: string;
  repoSlug: string;
  webBaseUrl: string;
}

export interface BitbucketPrMetadata {
  id: number;
  title: string;
  description: string;
  author: string;
  state: string;
  sourceBranch: string;
  sourceCommit: string;
  targetBranch: string;
  targetCommit: string;
  webUrl: string;
}

export interface BitbucketAuth {
  username?: string;
  token: string;
}

export interface LocalDiffTarget {
  kind: 'local-diff';
  repoRoot: string;
  baseRef: string;
  effectiveBaseRef: string;
  headRef: string;
  title: string;
  subtitle: string;
}

export interface BitbucketPrTarget {
  kind: 'bitbucket-pr';
  repoRoot: string;
  baseRef: string;
  effectiveBaseRef: string;
  headRef: string;
  title: string;
  subtitle: string;
  remote: BitbucketRemoteInfo;
  pr: BitbucketPrMetadata;
}

export type BranchExploreStartMode =
  | 'instruction'
  | 'auto-overview'
  | 'standby'
  | 'core-path-line-review';

export interface CorePathEntryHint {
  file: string;
  line: number;
  endLine?: number;
  selectedSnippet?: string;
}

export interface BranchExploreTarget {
  kind: 'branch-explore';
  repoRoot: string;
  branchName: string;
  /** Kept as 'HEAD' for compatibility with URI/comment helpers */
  baseRef: string;
  effectiveBaseRef: string;
  headRef: string;
  title: string;
  subtitle: string;
  initialInstruction?: string;
  startMode: BranchExploreStartMode;
  entryHint?: CorePathEntryHint;
}

export interface RepoOverviewSummary {
  branchName: string;
  totalTrackedFiles: number;
  includedFiles: number;
  ignoredFiles: number;
  directorySummaries: string[];
  keyDocs: Array<{ path: string; snippet: string }>;
  workingTreeChanges: string[];
  activeEditorFile?: string;
}

export type ReviewTarget = LocalDiffTarget | BitbucketPrTarget | BranchExploreTarget;

export interface GitRefItem {
  name: string;
  kind: 'local-branch' | 'remote-branch' | 'commit';
  sha: string;
  subject?: string;
}

export interface GitRemoteItem {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export interface FileChangeSummary {
  path: string;
  oldPath?: string;
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T';
  additions: number;
  deletions: number;
  isBinary: boolean;
  isIgnored: boolean;
  moduleGroup: string;
  hunkHeaders: string[];
  touchedSymbols?: string[];
  compactDiff: string;
}

export interface ChapterPlan {
  index: number;
  title: string;
  moduleGroup: string;
  files: string[];
  summary: string;
}

export interface ReviewContextPack {
  target: ReviewTarget;
  generatedAt: string;
  commits: string[];
  totalFilesChanged: number;
  includedFilesCount: number;
  ignoredFilesCount: number;
  totalAdditions: number;
  totalDeletions: number;
  files: FileChangeSummary[];
  chapters: ChapterPlan[];
  moduleClusters: Array<{
    moduleGroup: string;
    fileCount: number;
    additions: number;
    deletions: number;
    files: string[];
  }>;
  repoOverview?: RepoOverviewSummary;
}
