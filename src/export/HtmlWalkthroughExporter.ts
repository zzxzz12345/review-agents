import {
  matchActiveCallChainNode,
} from '../orchestrator/callChainUtils';
import {
  findNodeIdForFile,
  parseCodeMapTarget,
  parseHunkHeadRanges,
  resolveBestDefaultLinesForFile,
} from '../orchestrator/ReviewSession';
import type { ReviewContextPack, ReviewTarget } from '../context/types';
import type {
  AudioSegmentPayload,
  CallChainState,
  ChapterProgress,
  CodeGotoDirective,
  LineRange,
  ReviewModeStyle,
  ReviewNoteDraft,
} from '../shared/protocol';
import {
  applyWhiteboardDirective,
  createEmptyWhiteboardTree,
  deriveActivePath,
  type WhiteboardTreeState,
} from '../shared/whiteboardTree';
import {
  clampHighlightRange,
  recalibrateTopBoilerplateRange,
} from '../vscode-ui/highlightRange';

export interface ExportTimelineEntryInput {
  index: number;
  groupId: number;
  groupTitle: string;
  payload: AudioSegmentPayload;
}

export interface ExportTimelineInput {
  target: ReviewTarget;
  contextPack?: ReviewContextPack;
  reviewMode: ReviewModeStyle;
  timeline: ExportTimelineEntryInput[];
  notes: ReviewNoteDraft[];
  loadFileContent: (relPath: string) => Promise<string | null>;
  renderDiagrams?: (
    diagrams: Array<{ key: string; mermaidCode: string }>
  ) => Promise<Record<string, string>>;
}

export interface ExportedCodeFile {
  path: string;
  language: string;
  content: string;
  totalLines: number;
  truncated?: boolean;
  modifiedRanges?: LineRange[];
}

export interface ExportedDiagramAsset {
  key: string;
  id: string;
  title: string;
  mermaidCode: string;
  svg?: string;
  nodeCodeMap?: Record<string, string>;
}

export interface ExportedBreadcrumbItem {
  id: string;
  title: string;
  level: number;
  diagramKey: string;
}

export interface ExportedStep {
  index: number;
  groupId: number;
  groupTitle: string;
  spokenText: string;
  chapter?: ChapterProgress;
  diagramKey?: string;
  breadcrumbs: ExportedBreadcrumbItem[];
  focusedNodeId?: string;
  focusedEdge?: string;
  code?: {
    file: string;
    lines?: LineRange;
    label?: string;
  };
  callChain?: CallChainState | null;
  audioBase64: string;
  mimeType: string;
  ttsRate: number;
  fallbackTextOnly?: boolean;
}

export interface ExportedCheckpoint {
  startIndex: number;
  segmentCount: number;
  title: string;
}

export interface WalkthroughExportBundle {
  version: 1;
  exportedAt: string;
  meta: {
    title: string;
    subtitle: string;
    sourceKind: ReviewTarget['kind'];
    reviewMode: ReviewModeStyle;
    branchName?: string;
    diffStats?: {
      filesChanged: number;
      additions: number;
      deletions: number;
    };
  };
  steps: ExportedStep[];
  checkpoints: ExportedCheckpoint[];
  diagrams: Record<string, ExportedDiagramAsset>;
  files: Record<string, ExportedCodeFile>;
  notes: ReviewNoteDraft[];
}

const MAX_EXPORT_FILE_LINES = 4000;
const MAX_EXPORT_FILE_CHARS = 400_000;
const MAX_EXPORT_TOTAL_CHARS = 1_500_000;
const MAX_EXTRA_PACK_FILES = 30;
const FILE_LOAD_BATCH_SIZE = 8;

function normalizeRelPath(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/^\.\//, '');
}

function makeDiagramKey(id: string, title: string, mermaidCode: string): string {
  return `${id}\0${title}\0${mermaidCode}`;
}

export function inferCodeLanguage(filePath: string): string {
  const lower = filePath.toLowerCase();
  const ext = lower.split('.').pop() ?? '';
  switch (ext) {
    case 'py':
    case 'pyi':
      return 'python';
    case 'ts':
    case 'tsx':
    case 'mts':
    case 'cts':
      return 'typescript';
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'go':
      return 'go';
    case 'rs':
      return 'rust';
    case 'java':
    case 'kt':
      return 'java';
    case 'sql':
      return 'sql';
    case 'json':
    case 'jsonl':
      return 'json';
    case 'yml':
    case 'yaml':
      return 'yaml';
    case 'sh':
    case 'bash':
    case 'zsh':
      return 'bash';
    case 'css':
    case 'scss':
      return 'css';
    case 'html':
    case 'xml':
    case 'svg':
      return 'markup';
    case 'md':
      return 'markdown';
    default:
      return 'text';
  }
}

function truncateCodeContent(raw: string): {
  content: string;
  totalLines: number;
  truncated: boolean;
} {
  const normalized = raw.replace(/\r\n/g, '\n');
  const allLines = normalized.split('\n');
  const totalLines = allLines.length;
  let truncated = false;
  let sliced = normalized;

  if (allLines.length > MAX_EXPORT_FILE_LINES) {
    sliced = allLines.slice(0, MAX_EXPORT_FILE_LINES).join('\n');
    truncated = true;
  }
  if (sliced.length > MAX_EXPORT_FILE_CHARS) {
    sliced = sliced.slice(0, MAX_EXPORT_FILE_CHARS);
    const lastNl = sliced.lastIndexOf('\n');
    if (lastNl > 0) {
      sliced = sliced.slice(0, lastNl);
    }
    truncated = true;
  }
  return { content: sliced, totalLines, truncated };
}

export async function buildWalkthroughExportBundle(
  input: ExportTimelineInput
): Promise<WalkthroughExportBundle> {
  let tree: WhiteboardTreeState = createEmptyWhiteboardTree();
  let currentCallChain: CallChainState | null = null;
  let currentChapter: ChapterProgress | undefined;
  let activeFile: string | undefined;
  let activeLines: LineRange | undefined;
  let activeLabel: string | undefined;

  const diagramAssets = new Map<string, ExportedDiagramAsset>();
  const keyToShortId = new Map<string, string>();
  const referencedFiles = new Set<string>();
  const rawSteps: ExportedStep[] = [];
  const checkpoints: ExportedCheckpoint[] = [];

  const registerDiagram = (node: {
    id: string;
    title: string;
    mermaidCode: string;
    nodeCodeMap?: Record<string, string>;
  }): string => {
    const rawKey = makeDiagramKey(node.id, node.title, node.mermaidCode);
    let shortKey = keyToShortId.get(rawKey);
    if (!shortKey) {
      shortKey = `diag_${keyToShortId.size + 1}`;
      keyToShortId.set(rawKey, shortKey);
      diagramAssets.set(shortKey, {
        key: shortKey,
        id: node.id,
        title: node.title,
        mermaidCode: node.mermaidCode,
        nodeCodeMap: node.nodeCodeMap ? { ...node.nodeCodeMap } : undefined,
      });
    } else if (node.nodeCodeMap) {
      const existing = diagramAssets.get(shortKey);
      if (existing) {
        existing.nodeCodeMap = { ...existing.nodeCodeMap, ...node.nodeCodeMap };
      }
    }
    if (node.nodeCodeMap) {
      for (const targetRef of Object.values(node.nodeCodeMap)) {
        const parsed = parseCodeMapTarget(targetRef);
        if (parsed?.file) {
          referencedFiles.add(normalizeRelPath(parsed.file));
        }
      }
    }
    return shortKey;
  };

  for (let i = 0; i < input.timeline.length; i++) {
    const entry = input.timeline[i];
    const seg = entry.payload.segment;
    const allDirs = [...seg.directivesBefore, ...seg.directivesAfter];

    const hasExplicitWbUpdate = allDirs.some(
      (d) =>
        d.type === 'wb_render' ||
        d.type === 'wb_focus' ||
        d.type === 'wb_pop' ||
        d.type === 'wb_clear'
    );
    const hasExplicitCodeGoto = allDirs.some((d) => d.type === 'code_goto');
    let updatedCallChainThisStep = false;

    for (const dir of allDirs) {
      if (
        dir.type === 'wb_render' ||
        dir.type === 'wb_focus' ||
        dir.type === 'wb_pop' ||
        dir.type === 'wb_clear'
      ) {
        tree = applyWhiteboardDirective(tree, dir);
      } else if (dir.type === 'chapter') {
        currentChapter = {
          index: dir.index,
          total: dir.total,
          title: dir.title,
        };
      } else if (dir.type === 'call_chain') {
        currentCallChain = {
          title: dir.title,
          nodes: dir.nodes.map((n) => ({
            ...n,
            file: normalizeRelPath(n.file),
          })),
          activeIndex: dir.activeIndex,
          source: 'agent',
        };
        updatedCallChainThisStep = true;
        for (const n of currentCallChain.nodes) {
          if (n.file) {
            referencedFiles.add(n.file);
          }
        }
      } else if (dir.type === 'code_goto') {
        const cleanFile = normalizeRelPath(dir.file);
        const preferred = resolveBestDefaultLinesForFile(cleanFile, input.contextPack);
        activeFile = cleanFile;
        activeLines = dir.lines
          ? clampHighlightRange(dir.lines)
          : preferred;
        activeLabel = dir.label;
        if (cleanFile) {
          referencedFiles.add(cleanFile);
        }
        if (!hasExplicitWbUpdate) {
          const matchedNode = findNodeIdForFile(
            deriveActivePath(tree).stack.slice(-1)[0],
            cleanFile
          );
          if (matchedNode) {
            tree = applyWhiteboardDirective(tree, { type: 'wb_focus', id: matchedNode });
          }
        }
      }
    }

    if (!hasExplicitCodeGoto) {
      const focusDirs = allDirs.filter((d) => d.type === 'wb_focus');
      const lastFocus = focusDirs[focusDirs.length - 1];
      if (lastFocus && lastFocus.type === 'wb_focus') {
        const activePath = deriveActivePath(tree).stack;
        let mappedTarget: string | undefined;
        for (let k = activePath.length - 1; k >= 0; k--) {
          if (activePath[k].nodeCodeMap?.[lastFocus.id]) {
            mappedTarget = activePath[k].nodeCodeMap?.[lastFocus.id];
            break;
          }
        }
        const parsed = mappedTarget ? parseCodeMapTarget(mappedTarget) : null;
        if (parsed?.file) {
          const cleanFile = normalizeRelPath(parsed.file);
          const preferred = resolveBestDefaultLinesForFile(cleanFile, input.contextPack);
          activeFile = cleanFile;
          activeLines = parsed.lines
            ? clampHighlightRange(parsed.lines)
            : preferred ?? { start: 1, end: 8 };
          activeLabel = lastFocus.id;
          referencedFiles.add(cleanFile);
        }
      }
    }

    if (!updatedCallChainThisStep && currentCallChain && activeFile) {
      const matchedIdx = matchActiveCallChainNode(
        currentCallChain.nodes,
        activeFile,
        activeLines?.start
      );
      if (matchedIdx >= 0 && matchedIdx !== currentCallChain.activeIndex) {
        currentCallChain = {
          ...currentCallChain,
          activeIndex: matchedIdx,
        };
      }
    }

    const { stack: activeStack, activeIndex } = deriveActivePath(tree);
    const breadcrumbs: ExportedBreadcrumbItem[] = activeStack.map((node) => ({
      id: node.id,
      title: node.title,
      level: node.level ?? 1,
      diagramKey: registerDiagram(node),
    }));
    const activeDiagram =
      activeIndex >= 0 && activeIndex < activeStack.length
        ? activeStack[activeIndex]
        : undefined;
    const activeBreadcrumb =
      activeIndex >= 0 && activeIndex < breadcrumbs.length
        ? breadcrumbs[activeIndex]
        : undefined;

    rawSteps.push({
      index: i,
      groupId: entry.groupId,
      groupTitle: entry.groupTitle,
      spokenText: seg.spokenText,
      chapter: currentChapter ? { ...currentChapter } : undefined,
      diagramKey: activeBreadcrumb?.diagramKey,
      breadcrumbs,
      focusedNodeId: activeDiagram?.focusedNodeId,
      focusedEdge: activeDiagram?.focusedEdge,
      code: activeFile
        ? {
            file: activeFile,
            lines: activeLines ? { ...activeLines } : undefined,
            label: activeLabel,
          }
        : undefined,
      callChain: currentCallChain
        ? {
            ...currentCallChain,
            nodes: currentCallChain.nodes.map((n) => ({ ...n })),
          }
        : null,
      audioBase64: entry.payload.audioBase64,
      mimeType: entry.payload.mimeType,
      ttsRate: entry.payload.ttsRate,
      fallbackTextOnly: entry.payload.fallbackTextOnly,
    });

    const prevCp = checkpoints[checkpoints.length - 1];
    if (!prevCp || input.timeline[prevCp.startIndex]?.groupId !== entry.groupId) {
      checkpoints.push({
        startIndex: i,
        segmentCount: 1,
        title: entry.groupTitle,
      });
    } else {
      prevCp.segmentCount += 1;
      prevCp.title = entry.groupTitle || prevCp.title;
    }
  }

  for (const note of input.notes) {
    if (note.file && note.file !== 'PR-General' && note.file !== 'Project-General') {
      referencedFiles.add(normalizeRelPath(note.file));
    }
  }

  // Load source files cleanly in bounded parallel batches (prioritize referenced files,
  // then include extra modified non-ignored files from contextPack up to soft caps).
  const filesMap: Record<string, ExportedCodeFile> = {};
  const modifiedMap = new Map<string, LineRange[]>();
  const extraPackFiles: string[] = [];
  if (input.contextPack) {
    for (const f of input.contextPack.files) {
      const norm = normalizeRelPath(f.path);
      if (f.hunkHeaders.length > 0) {
        modifiedMap.set(norm, parseHunkHeadRanges(f.hunkHeaders));
      }
      if (!f.isIgnored && !f.isBinary && !referencedFiles.has(norm) && extraPackFiles.length < MAX_EXTRA_PACK_FILES) {
        extraPackFiles.push(norm);
      }
    }
  }

  const prioritizedFiles = Array.from(referencedFiles).filter(Boolean);
  const candidateFiles = [...prioritizedFiles, ...extraPackFiles];
  const prioritizedSet = new Set(prioritizedFiles);
  let totalEmbeddedChars = 0;

  for (let i = 0; i < candidateFiles.length; i += FILE_LOAD_BATCH_SIZE) {
    const batch = candidateFiles.slice(i, i + FILE_LOAD_BATCH_SIZE);
    await Promise.all(
      batch.map(async (relPath) => {
        if (!prioritizedSet.has(relPath) && totalEmbeddedChars >= MAX_EXPORT_TOTAL_CHARS) {
          return;
        }
        try {
          const raw = await input.loadFileContent(relPath);
          if (raw === null || raw === undefined) {
            return;
          }
          const { content, totalLines, truncated } = truncateCodeContent(raw);
          if (!prioritizedSet.has(relPath) && totalEmbeddedChars + content.length > MAX_EXPORT_TOTAL_CHARS) {
            return;
          }
          totalEmbeddedChars += content.length;
          filesMap[relPath] = {
            path: relPath,
            language: inferCodeLanguage(relPath),
            content,
            totalLines,
            truncated: truncated || undefined,
            modifiedRanges: modifiedMap.get(relPath),
          };
        } catch {
          // Ignore individual unreadable files so export still succeeds
        }
      })
    );
  }

  // Recalibrate any top-of-file import boilerplate highlights against loaded file headers
  const headLinesCache = new Map<string, string[]>();
  for (const step of rawSteps) {
    if (!step.code?.lines) {
      continue;
    }
    const codeFile = filesMap[step.code.file];
    if (!codeFile) {
      continue;
    }
    let headLines = headLinesCache.get(step.code.file);
    if (!headLines) {
      headLines = codeFile.content.split('\n').slice(0, 250);
      headLinesCache.set(step.code.file, headLines);
    }
    const preferredLines = resolveBestDefaultLinesForFile(step.code.file, input.contextPack);
    step.code.lines = recalibrateTopBoilerplateRange(headLines, step.code.lines, {
      label: step.code.label,
      preferredLines,
      totalLineCount: codeFile.totalLines,
    });
  }

  // Pre-render unique Mermaid diagrams into offline SVGs when callback is provided
  if (input.renderDiagrams && diagramAssets.size > 0) {
    try {
      const payload = Array.from(diagramAssets.values()).map((d) => ({
        key: d.key,
        mermaidCode: d.mermaidCode,
      }));
      const svgs = await input.renderDiagrams(payload);
      for (const [key, svg] of Object.entries(svgs ?? {})) {
        const asset = diagramAssets.get(key);
        if (asset && typeof svg === 'string' && svg.trim().startsWith('<svg')) {
          asset.svg = svg;
        }
      }
    } catch {
      // Fallback gracefully when SVG pre-rendering is unavailable
    }
  }

  const diagramsObj: Record<string, ExportedDiagramAsset> = {};
  for (const [key, asset] of diagramAssets.entries()) {
    diagramsObj[key] = asset;
  }

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    meta: {
      title: input.target.title,
      subtitle: input.target.subtitle,
      sourceKind: input.target.kind,
      reviewMode: input.reviewMode,
      branchName:
        input.target.kind === 'branch-explore'
          ? input.target.branchName
          : input.contextPack?.repoOverview?.branchName,
      diffStats:
        input.contextPack && input.target.kind !== 'branch-explore'
          ? {
              filesChanged: input.contextPack.totalFilesChanged,
              additions: input.contextPack.totalAdditions,
              deletions: input.contextPack.totalDeletions,
            }
          : undefined,
    },
    steps: rawSteps,
    checkpoints,
    diagrams: diagramsObj,
    files: filesMap,
    notes: input.notes.map((n) => ({ ...n })),
  };
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function serializeJsonForScriptTag(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function renderStandaloneWalkthroughHtml(bundle: WalkthroughExportBundle): string {
  const embeddedJson = serializeJsonForScriptTag(bundle);
  const safeTitle = escapeHtml(bundle.meta.title || 'Review Agents Walkthrough');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${safeTitle} · Review Agents 导读回放</title>
<style>
  :root {
    --bg: #f8fafc;
    --surface: #ffffff;
    --surface-2: #f1f5f9;
    --border: #e2e8f0;
    --text: #0f172a;
    --muted: #64748b;
    --accent: #4f46e5;
    --accent-soft: rgba(79, 70, 229, 0.12);
    --hl-bg: rgba(251, 191, 36, 0.24);
    --hl-border: #d97706;
    --mod-gutter: #22c55e;
    --code-bg: #ffffff;
    --code-gutter: #f8fafc;
    --kw: #7c3aed;
    --str: #047857;
    --cmt: #94a3b8;
    --num: #c2410c;
    --shadow: 0 8px 24px rgba(15, 23, 42, 0.08);
  }
  html[data-theme="dark"] {
    --bg: #0f172a;
    --surface: #1e293b;
    --surface-2: #0f172a;
    --border: #334155;
    --text: #f1f5f9;
    --muted: #94a3b8;
    --accent: #818cf8;
    --accent-soft: rgba(129, 140, 248, 0.18);
    --hl-bg: rgba(245, 158, 11, 0.22);
    --hl-border: #f59e0b;
    --mod-gutter: #4ade80;
    --code-bg: #0b1120;
    --code-gutter: #111827;
    --kw: #c4b5fd;
    --str: #6ee7b7;
    --cmt: #64748b;
    --num: #fdba74;
    --shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    height: 100%;
    width: 100%;
    overflow: hidden;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
    font-size: 13px;
  }
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
    width: 100vw;
  }
  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 14px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .topbar-left {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }
  .brand-pill {
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 700;
    padding: 3px 9px;
    border-radius: 999px;
    font-size: 11px;
    flex-shrink: 0;
  }
  .title-wrap { min-width: 0; }
  .title {
    font-weight: 700;
    font-size: 14px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .subtitle {
    color: var(--muted);
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .topbar-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }
  .btn {
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    border-radius: 7px;
    padding: 5px 10px;
    font-size: 12px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    transition: background 0.15s, border-color 0.15s;
  }
  .btn:hover { background: var(--surface-2); border-color: var(--accent); }
  .btn.active { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); font-weight: 600; }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
  .btn.primary:hover { opacity: 0.92; }

  .workspace {
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
    position: relative;
    overflow: hidden;
  }
  .workspace.swapped .split-main { flex-direction: row-reverse; }
  .split-main {
    display: flex;
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
  }
  .pane {
    display: flex;
    flex-direction: column;
    min-width: 220px;
    min-height: 0;
    background: var(--surface);
  }
  .code-pane { flex: 0 0 48%; }
  .wb-pane { flex: 1 1 auto; min-width: 260px; }
  .splitter {
    width: 5px;
    background: var(--border);
    cursor: col-resize;
    flex-shrink: 0;
    transition: background 0.15s;
  }
  .splitter:hover, .splitter.dragging { background: var(--accent); }

  .pane-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 7px 12px;
    background: var(--surface-2);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    min-height: 38px;
  }
  .file-select {
    flex: 1 1 auto;
    min-width: 0;
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 4px 8px;
    font-size: 12px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }
  .code-label-pill {
    font-size: 11px;
    color: var(--hl-border);
    background: var(--hl-bg);
    padding: 2px 8px;
    border-radius: 999px;
    white-space: nowrap;
    max-width: 45%;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .readonly-badge {
    font-size: 11px;
    color: var(--muted);
    background: var(--surface);
    border: 1px solid var(--border);
    padding: 2px 7px;
    border-radius: 6px;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .monaco-host {
    flex: 1 1 auto;
    min-height: 0;
    width: 100%;
    position: relative;
  }
  .ra-monaco-hl-line {
    background: var(--hl-bg) !important;
    border-left: 3px solid var(--hl-border) !important;
  }
  .ra-monaco-hl-gutter {
    border-left: 3px solid var(--hl-border);
  }
  .ra-monaco-mod-gutter {
    border-left: 3px solid var(--mod-gutter);
  }
  .ra-monaco-hl-label {
    color: var(--hl-border) !important;
    font-style: italic;
    font-size: 12px;
  }
  .code-scroll {
    flex: 1 1 auto;
    overflow: auto;
    background: var(--code-bg);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    font-size: 12.5px;
    line-height: 1.58;
  }
  .code-empty {
    padding: 36px 24px;
    color: var(--muted);
    text-align: center;
  }
  .code-table {
    width: 100%;
    border-collapse: collapse;
    table-layout: auto;
  }
  .code-row { transition: background 0.15s; }
  .code-row.hl {
    background: var(--hl-bg);
  }
  .code-ln {
    width: 52px;
    min-width: 46px;
    text-align: right;
    padding: 0 10px 0 6px;
    color: var(--muted);
    background: var(--code-gutter);
    user-select: none;
    border-right: 1px solid var(--border);
    border-left: 3px solid transparent;
    vertical-align: top;
  }
  .code-row.mod .code-ln {
    border-left-color: var(--mod-gutter);
  }
  .code-row.hl .code-ln {
    border-left-color: var(--hl-border);
    color: var(--text);
    font-weight: 700;
  }
  .code-txt {
    padding: 0 12px;
    white-space: pre;
    vertical-align: top;
  }
  .hl-badge {
    display: inline-block;
    margin-left: 16px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 11px;
    font-style: italic;
    color: var(--hl-border);
    opacity: 0.92;
    user-select: none;
  }
  .tok-kw { color: var(--kw); font-weight: 600; }
  .tok-str { color: var(--str); }
  .tok-cmt { color: var(--cmt); font-style: italic; }
  .tok-num { color: var(--num); }

  .breadcrumbs {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
    min-width: 0;
    flex: 1 1 auto;
  }
  .crumb-btn {
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    border-radius: 6px;
    padding: 3px 8px;
    font-size: 11.5px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    max-width: 240px;
  }
  .crumb-btn.active {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 600;
  }
  .crumb-lv {
    font-size: 10px;
    font-weight: 700;
    opacity: 0.85;
  }
  .crumb-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .crumb-sep { color: var(--muted); font-size: 11px; }

  .wb-stage-wrap {
    flex: 1 1 auto;
    position: relative;
    overflow: hidden;
    background: var(--surface);
    cursor: grab;
    user-select: none;
  }
  .wb-stage-wrap:active { cursor: grabbing; }
  .wb-canvas {
    width: 100%;
    height: 100%;
    transform-origin: 0 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .wb-canvas svg {
    max-width: none !important;
    overflow: visible;
  }
  .wb-controls {
    position: absolute;
    right: 12px;
    bottom: 12px;
    display: flex;
    gap: 4px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 4px;
    box-shadow: var(--shadow);
  }
  .wb-hint {
    position: absolute;
    left: 12px;
    bottom: 12px;
    font-size: 11px;
    color: var(--muted);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 3px 8px;
    opacity: 0.9;
    pointer-events: none;
  }
  .wb-canvas .ra-node-focused rect,
  .wb-canvas .ra-node-focused polygon,
  .wb-canvas .ra-node-focused circle,
  .wb-canvas .ra-node-focused path {
    stroke: var(--accent) !important;
    stroke-width: 3px !important;
    filter: drop-shadow(0 0 8px rgba(79, 70, 229, 0.55));
  }
  .wb-canvas .ra-dimmed { opacity: 0.34 !important; transition: opacity 0.2s; }
  .wb-canvas .ra-clickable { cursor: pointer; }
  .wb-source-fallback {
    padding: 20px;
    max-width: 90%;
    max-height: 90%;
    overflow: auto;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    white-space: pre-wrap;
  }

  .drawer {
    width: 340px;
    max-width: 38vw;
    border-left: 1px solid var(--border);
    background: var(--surface);
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex-shrink: 0;
  }
  .drawer.hidden { display: none; }
  .drawer-tabs {
    display: flex;
    border-bottom: 1px solid var(--border);
    background: var(--surface-2);
  }
  .drawer-tab {
    flex: 1;
    border: none;
    background: transparent;
    color: var(--muted);
    padding: 9px 6px;
    font-size: 12px;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    font-weight: 500;
  }
  .drawer-tab.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
    background: var(--surface);
    font-weight: 600;
  }
  .drawer-body {
    flex: 1 1 auto;
    overflow: auto;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .seg-item {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px 10px;
    cursor: pointer;
    background: var(--surface);
    transition: border-color 0.15s, background 0.15s;
  }
  .seg-item:hover { border-color: var(--accent); }
  .seg-item.active {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .seg-item-meta {
    display: flex;
    justify-content: space-between;
    font-size: 11px;
    color: var(--muted);
    margin-bottom: 4px;
  }
  .seg-item-text {
    font-size: 12.5px;
    line-height: 1.5;
  }
  .chapter-pill {
    font-size: 11px;
    font-weight: 700;
    color: var(--accent);
    background: var(--accent-soft);
    padding: 4px 8px;
    border-radius: 6px;
    margin-top: 4px;
  }
  .chain-node {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px 10px;
    cursor: pointer;
  }
  .chain-node.active {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .chain-sym { font-weight: 600; font-size: 12.5px; }
  .chain-loc { font-size: 11px; color: var(--muted); font-family: ui-monospace, monospace; margin-top: 2px; }
  .chain-role { font-size: 11.5px; margin-top: 4px; }
  .note-card {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px 10px;
  }
  .note-top {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    margin-bottom: 4px;
  }
  .sev {
    font-weight: 700;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 10px;
    text-transform: uppercase;
  }
  .sev.action { background: rgba(79, 70, 229, 0.16); color: var(--accent); }
  .sev.issue { background: rgba(239, 68, 68, 0.16); color: #ef4444; }
  .sev.warning { background: rgba(245, 158, 11, 0.18); color: #d97706; }
  .sev.info { background: var(--surface-2); color: var(--muted); }
  .note-loc-btn {
    border: none;
    background: transparent;
    color: var(--accent);
    font-family: ui-monospace, monospace;
    font-size: 11px;
    cursor: pointer;
    padding: 0;
    text-decoration: underline;
  }

  .player {
    background: var(--surface);
    border-top: 1px solid var(--border);
    padding: 8px 14px 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    flex-shrink: 0;
  }
  .subtitle-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 7px 12px;
  }
  .subtitle-text {
    font-size: 13.5px;
    line-height: 1.5;
    font-weight: 500;
    flex: 1 1 auto;
  }
  .subtitle-status {
    font-size: 11.5px;
    color: var(--muted);
    white-space: nowrap;
    flex-shrink: 0;
  }
  .progress-wrap {
    position: relative;
    height: 10px;
    background: var(--surface-2);
    border-radius: 999px;
    cursor: pointer;
    border: 1px solid var(--border);
  }
  .progress-fill {
    height: 100%;
    background: var(--accent);
    border-radius: 999px;
    width: 0%;
    transition: width 0.15s;
  }
  .cp-marker {
    position: absolute;
    top: -3px;
    width: 3px;
    height: 14px;
    background: var(--hl-border);
    border-radius: 2px;
    transform: translateX(-50%);
    pointer-events: auto;
  }
  .controls-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
  }
  .controls-group {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .select-sm {
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    border-radius: 6px;
    padding: 4px 8px;
    font-size: 12px;
  }
  @media (max-width: 900px) {
    .split-main { flex-direction: column !important; }
    .code-pane { flex: 0 0 46%; width: 100%; }
    .splitter { width: 100%; height: 5px; cursor: row-resize; }
    .drawer { position: absolute; right: 0; top: 0; bottom: 0; z-index: 20; box-shadow: var(--shadow); }
  }
</style>
</head>
<body>
<div class="app">
  <header class="topbar">
    <div class="topbar-left">
      <span class="brand-pill" id="modeBadge">导读回放</span>
      <div class="title-wrap">
        <div class="title" id="docTitle">${safeTitle}</div>
        <div class="subtitle" id="docSubtitle"></div>
      </div>
    </div>
    <div class="topbar-actions">
      <button type="button" class="btn" id="btnSwap">左右互换</button>
      <button type="button" class="btn active" id="btnDrawer">章节与批注</button>
      <button type="button" class="btn" id="btnTheme">切换主题</button>
    </div>
  </header>

  <main class="workspace" id="workspace">
    <div class="split-main">
      <section class="pane code-pane" id="codePane">
        <div class="pane-header">
          <select class="file-select" id="fileSelect" aria-label="切换代码文件"></select>
          <span class="readonly-badge" id="editorBadge" title="嵌入 HTML 中的独立只读代码副本">只读副本</span>
          <span class="code-label-pill" id="codeLabel" style="display:none;"></span>
        </div>
        <div class="monaco-host" id="monacoHost" style="display:none;"></div>
        <div class="code-scroll" id="codeScroll">
          <div class="code-empty">等待播放片段跳转到对应代码...</div>
        </div>
      </section>

      <div class="splitter" id="splitter" role="separator" aria-label="调整分屏宽度"></div>

      <section class="pane wb-pane" id="wbPane">
        <div class="pane-header">
          <div class="breadcrumbs" id="breadcrumbs"></div>
        </div>
        <div class="wb-stage-wrap" id="wbStageWrap">
          <div class="wb-canvas" id="wbCanvas"></div>
          <div class="wb-hint">双指拖动平移 · 捏合/⌘滚轮缩放 · 点击白板节点跳转代码</div>
          <div class="wb-controls">
            <button type="button" class="btn" id="btnZoomOut" title="缩小">－</button>
            <button type="button" class="btn" id="btnFit" title="适应窗口">适应</button>
            <button type="button" class="btn" id="btnZoomIn" title="放大">＋</button>
          </div>
        </div>
      </section>
    </div>

    <aside class="drawer" id="drawer">
      <div class="drawer-tabs">
        <button type="button" class="drawer-tab active" data-tab="transcript">章节与逐字稿</button>
        <button type="button" class="drawer-tab" data-tab="chain">调用链</button>
        <button type="button" class="drawer-tab" data-tab="notes">批注</button>
      </div>
      <div class="drawer-body" id="drawerBody"></div>
    </aside>
  </main>

  <footer class="player">
    <div class="subtitle-bar">
      <div class="subtitle-text" id="subtitleText">点击「播放」开始音画同步回放</div>
      <div class="subtitle-status" id="subtitleStatus">0 / 0</div>
    </div>
    <div class="progress-wrap" id="progressBar" title="点击跳转进度">
      <div class="progress-fill" id="progressFill"></div>
      <div id="checkpointMarkers"></div>
    </div>
    <div class="controls-row">
      <div class="controls-group">
        <button type="button" class="btn" id="btnPrev" title="上一句 (←)">⏮ 上一句</button>
        <button type="button" class="btn primary" id="btnPlay" title="播放 / 暂停 (Space)">▶ 播放</button>
        <button type="button" class="btn" id="btnNext" title="下一句 (→)">下一句 ⏭</button>
        <button type="button" class="btn" id="btnRestart" title="从头重放">↺ 从头</button>
      </div>
      <div class="controls-group">
        <label for="rateSelect" style="font-size:12px;color:var(--muted);">语速</label>
        <select class="select-sm" id="rateSelect">
          <option value="0.8">0.8x</option>
          <option value="1" selected>1.0x</option>
          <option value="1.2">1.2x</option>
          <option value="1.5">1.5x</option>
          <option value="2">2.0x</option>
        </select>
        <button type="button" class="btn" id="btnMute">🔊 有声</button>
        <select class="select-sm" id="checkpointSelect" aria-label="按章节跳转"></select>
      </div>
    </div>
  </footer>
</div>

<script id="ra-export-data" type="application/json">${embeddedJson}</script>
<script>
(function () {
  var dataEl = document.getElementById('ra-export-data');
  var BUNDLE = JSON.parse(dataEl ? dataEl.textContent : '{}');
  var steps = Array.isArray(BUNDLE.steps) ? BUNDLE.steps : [];
  var diagrams = BUNDLE.diagrams || {};
  var files = BUNDLE.files || {};
  var notes = Array.isArray(BUNDLE.notes) ? BUNDLE.notes : [];
  var checkpoints = Array.isArray(BUNDLE.checkpoints) ? BUNDLE.checkpoints : [];

  var currentIndex = 0;
  var playing = false;
  var playbackRate = 1.0;
  var muted = false;
  var activeTab = 'transcript';
  var manualDiagramKey = null;
  var activeFilePath = null;
  var activeCodeLines = null;
  var activeCodeLabel = null;
  var currentAudio = null;
  var fallbackTimer = null;
  var playToken = 0;

  // Pan & zoom state for whiteboard
  var panX = 0;
  var panY = 0;
  var zoomScale = 1;
  var mermaidLoaderPromise = null;

  // Read-only Monaco Editor state (loads from CDN, falls back cleanly to built-in view)
  var monacoEditor = null;
  var monacoReady = false;
  var monacoModels = {};
  var monacoDecorations = [];

  var dom = {
    modeBadge: document.getElementById('modeBadge'),
    docTitle: document.getElementById('docTitle'),
    docSubtitle: document.getElementById('docSubtitle'),
    workspace: document.getElementById('workspace'),
    codePane: document.getElementById('codePane'),
    splitter: document.getElementById('splitter'),
    fileSelect: document.getElementById('fileSelect'),
    editorBadge: document.getElementById('editorBadge'),
    codeLabel: document.getElementById('codeLabel'),
    monacoHost: document.getElementById('monacoHost'),
    codeScroll: document.getElementById('codeScroll'),
    breadcrumbs: document.getElementById('breadcrumbs'),
    wbStageWrap: document.getElementById('wbStageWrap'),
    wbCanvas: document.getElementById('wbCanvas'),
    drawer: document.getElementById('drawer'),
    drawerBody: document.getElementById('drawerBody'),
    subtitleText: document.getElementById('subtitleText'),
    subtitleStatus: document.getElementById('subtitleStatus'),
    progressBar: document.getElementById('progressBar'),
    progressFill: document.getElementById('progressFill'),
    checkpointMarkers: document.getElementById('checkpointMarkers'),
    checkpointSelect: document.getElementById('checkpointSelect'),
    btnPrev: document.getElementById('btnPrev'),
    btnPlay: document.getElementById('btnPlay'),
    btnNext: document.getElementById('btnNext'),
    btnRestart: document.getElementById('btnRestart'),
    btnMute: document.getElementById('btnMute'),
    btnSwap: document.getElementById('btnSwap'),
    btnDrawer: document.getElementById('btnDrawer'),
    btnTheme: document.getElementById('btnTheme'),
    btnZoomIn: document.getElementById('btnZoomIn'),
    btnZoomOut: document.getElementById('btnZoomOut'),
    btnFit: document.getElementById('btnFit'),
    rateSelect: document.getElementById('rateSelect')
  };

  function escapeHtmlText(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function highlightSyntaxLine(line, lang) {
    var html = escapeHtmlText(line);
    if (!line || lang === 'text' || lang === 'markdown') {
      return html || '&nbsp;';
    }
    var commentRe = (lang === 'python' || lang === 'bash' || lang === 'yaml')
      ? /(#.*)$/
      : (lang === 'sql')
        ? /(--.*)$/
        : /(\\/\\/.*)$/;
    var cmtPart = '';
    var codePart = html;
    var cm = html.match(commentRe);
    if (cm && cm.index !== undefined) {
      var prefixBefore = html.slice(0, cm.index);
      var quoteCount = (prefixBefore.match(/&quot;|&#39;|"|'/g) || []).length;
      if (quoteCount % 2 === 0) {
        codePart = prefixBefore;
        cmtPart = '<span class="tok-cmt">' + cm[1] + '</span>';
      }
    }
    codePart = codePart.replace(/("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')/g, '<span class="tok-str">$1</span>');
    codePart = codePart.replace(
      /\\b(def|async|await|class|return|if|elif|else|for|while|try|except|finally|with|as|import|from|export|const|let|var|function|interface|type|enum|struct|impl|pub|fn|func|package|SELECT|FROM|WHERE|CREATE|TABLE|INDEX|PRIMARY|KEY|true|false|null|None|True|False)\\b/g,
      '<span class="tok-kw">$1</span>'
    );
    codePart = codePart.replace(/\\b(\\d+(?:\\.\\d+)?)\\b/g, '<span class="tok-num">$1</span>');
    return (codePart + cmtPart) || '&nbsp;';
  }

  function isLineInRanges(lineNum, ranges) {
    if (!ranges || !ranges.length) return false;
    for (var i = 0; i < ranges.length; i++) {
      if (lineNum >= ranges[i].start && lineNum <= ranges[i].end) return true;
    }
    return false;
  }

  function populateHeaderAndSelectors() {
    var modeMap = {
      'walkthrough': 'PR / Diff 导读回放',
      'branch-explore': '分支 / 项目导读回放',
      'core-path-line-review': '核心链路逐行 Review 回放'
    };
    dom.modeBadge.textContent = modeMap[(BUNDLE.meta && BUNDLE.meta.reviewMode) || 'walkthrough'] || '导读回放';
    var subParts = [];
    if (BUNDLE.meta && BUNDLE.meta.subtitle) subParts.push(BUNDLE.meta.subtitle);
    if (BUNDLE.meta && BUNDLE.meta.diffStats) {
      subParts.push(BUNDLE.meta.diffStats.filesChanged + ' files (+' + BUNDLE.meta.diffStats.additions + '/-' + BUNDLE.meta.diffStats.deletions + ')');
    }
    if (BUNDLE.exportedAt) subParts.push('导出于 ' + BUNDLE.exportedAt.slice(0, 19).replace('T', ' '));
    dom.docSubtitle.textContent = subParts.join(' · ');

    var fileKeys = Object.keys(files).sort();
    dom.fileSelect.innerHTML = '';
    if (fileKeys.length === 0) {
      var emptyOpt = document.createElement('option');
      emptyOpt.value = '';
      emptyOpt.textContent = '（无嵌入代码文件）';
      dom.fileSelect.appendChild(emptyOpt);
    } else {
      for (var i = 0; i < fileKeys.length; i++) {
        var fp = fileKeys[i];
        var opt = document.createElement('option');
        opt.value = fp;
        opt.textContent = (files[fp].modifiedRanges && files[fp].modifiedRanges.length ? '[改] ' : '') + fp;
        dom.fileSelect.appendChild(opt);
      }
    }

    dom.checkpointSelect.innerHTML = '<option value="">跳转章节...</option>';
    dom.checkpointMarkers.innerHTML = '';
    for (var c = 0; c < checkpoints.length; c++) {
      var cp = checkpoints[c];
      var cpOpt = document.createElement('option');
      cpOpt.value = String(cp.startIndex);
      cpOpt.textContent = '#' + (cp.startIndex + 1) + ' ' + cp.title;
      dom.checkpointSelect.appendChild(cpOpt);

      if (steps.length > 1) {
        var marker = document.createElement('div');
        marker.className = 'cp-marker';
        marker.style.left = ((cp.startIndex / Math.max(1, steps.length - 1)) * 100) + '%';
        marker.title = cp.title;
        (function (idx) {
          marker.addEventListener('click', function (ev) {
            ev.stopPropagation();
            jumpToStep(idx, playing);
          });
        })(cp.startIndex);
        dom.checkpointMarkers.appendChild(marker);
      }
    }

    if (steps[0] && typeof steps[0].ttsRate === 'number' && steps[0].ttsRate > 0) {
      playbackRate = steps[0].ttsRate;
      dom.rateSelect.value = String(playbackRate);
      if (dom.rateSelect.value !== String(playbackRate)) {
        var customOpt = document.createElement('option');
        customOpt.value = String(playbackRate);
        customOpt.textContent = playbackRate + 'x';
        dom.rateSelect.appendChild(customOpt);
        dom.rateSelect.value = String(playbackRate);
      }
    }
  }

  function mapLangToMonaco(lang) {
    switch (lang) {
      case 'python': return 'python';
      case 'typescript': return 'typescript';
      case 'javascript': return 'javascript';
      case 'go': return 'go';
      case 'rust': return 'rust';
      case 'java': return 'java';
      case 'sql': return 'sql';
      case 'json': return 'json';
      case 'yaml': return 'yaml';
      case 'bash': return 'shell';
      case 'css': return 'css';
      case 'markup': return 'html';
      case 'markdown': return 'markdown';
      default: return 'plaintext';
    }
  }

  function syncMonacoCodeView(filePath, lines, label) {
    if (!monacoReady || !monacoEditor || !window.monaco || !filePath || !files[filePath]) {
      return false;
    }
    var m = window.monaco;
    var f = files[filePath];
    var model = monacoModels[filePath];
    if (!model) {
      model = m.editor.createModel(f.content, mapLangToMonaco(f.language));
      monacoModels[filePath] = model;
    }

    dom.codeScroll.style.display = 'none';
    dom.monacoHost.style.display = 'block';
    if (monacoEditor.getModel() !== model) {
      monacoEditor.setModel(model);
    }

    var lineCount = Math.max(1, model.getLineCount());
    var decos = [];
    if (f.modifiedRanges && f.modifiedRanges.length) {
      for (var i = 0; i < f.modifiedRanges.length; i++) {
        var mr = f.modifiedRanges[i];
        var ms = Math.max(1, Math.min(lineCount, mr.start));
        var me = Math.max(ms, Math.min(lineCount, mr.end || ms));
        decos.push({
          range: new m.Range(ms, 1, me, 1),
          options: { isWholeLine: true, linesDecorationsClassName: 'ra-monaco-mod-gutter' }
        });
      }
    }

    if (lines && lines.start > 0) {
      var s = Math.max(1, Math.min(lineCount, lines.start));
      var e = Math.max(s, Math.min(lineCount, lines.end || s));
      decos.push({
        range: new m.Range(s, 1, e, model.getLineMaxColumn(e)),
        options: {
          isWholeLine: true,
          className: 'ra-monaco-hl-line',
          linesDecorationsClassName: 'ra-monaco-hl-gutter'
        }
      });
      if (label) {
        decos.push({
          range: new m.Range(s, model.getLineMaxColumn(s), s, model.getLineMaxColumn(s)),
          options: {
            after: {
              content: '  ◀ ' + label,
              inlineClassName: 'ra-monaco-hl-label'
            }
          }
        });
      }
      try {
        monacoDecorations = monacoEditor.deltaDecorations(monacoDecorations, decos);
      } catch (_) {
        monacoDecorations = monacoEditor.deltaDecorations(monacoDecorations, decos.slice(0, -1));
      }
      monacoEditor.layout();
      monacoEditor.revealRangeInCenter(new m.Range(s, 1, e, 1), m.editor.ScrollType.Smooth);
    } else {
      monacoDecorations = monacoEditor.deltaDecorations(monacoDecorations, decos);
      monacoEditor.layout();
      monacoEditor.setScrollTop(0);
    }
    return true;
  }

  function initMonacoEditor() {
    var base = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min';
    window.MonacoEnvironment = {
      getWorkerUrl: function () {
        var code = "self.MonacoEnvironment={baseUrl:'" + base + "/'};importScripts('" + base + "/vs/base/worker/workerMain.js');";
        return 'data:text/javascript;charset=utf-8,' + encodeURIComponent(code);
      }
    };
    var script = document.createElement('script');
    script.src = base + '/vs/loader.js';
    script.onload = function () {
      if (typeof window.require !== 'function') return;
      window.require.config({ paths: { vs: base + '/vs' } });
      window.require(['vs/editor/editor.main'], function () {
        if (!window.monaco || !dom.monacoHost) return;
        var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        monacoEditor = window.monaco.editor.create(dom.monacoHost, {
          value: '',
          language: 'plaintext',
          theme: isDark ? 'vs-dark' : 'vs',
          readOnly: true,
          domReadOnly: true,
          automaticLayout: true,
          minimap: { enabled: true },
          folding: true,
          glyphMargin: true,
          scrollBeyondLastLine: false,
          renderLineHighlight: 'none',
          fontSize: 13,
          lineHeight: 20,
          padding: { top: 8, bottom: 12 }
        });
        monacoReady = true;
        if (dom.editorBadge) {
          dom.editorBadge.textContent = '只读副本 · Monaco';
        }
        if (activeFilePath && files[activeFilePath]) {
          syncMonacoCodeView(activeFilePath, activeCodeLines, activeCodeLabel);
        }
      });
    };
    script.onerror = function () { /* Keep built-in fallback reader seamlessly */ };
    document.head.appendChild(script);
  }

  function renderCodeView(filePath, lines, label) {
    activeFilePath = filePath || null;
    activeCodeLines = lines || null;
    activeCodeLabel = label || null;

    if (label) {
      dom.codeLabel.textContent = '◀ ' + label;
      dom.codeLabel.style.display = 'inline-block';
    } else {
      dom.codeLabel.style.display = 'none';
    }

    if (!filePath || !files[filePath]) {
      dom.monacoHost.style.display = 'none';
      dom.codeScroll.style.display = 'block';
      dom.codeScroll.innerHTML = '<div class="code-empty">' +
        (filePath ? ('未嵌入文件源码：' + escapeHtmlText(filePath)) : '当前步骤未关联代码位置') +
        '</div>';
      return;
    }

    dom.fileSelect.value = filePath;
    if (syncMonacoCodeView(filePath, lines, label)) {
      return;
    }
    dom.monacoHost.style.display = 'none';
    dom.codeScroll.style.display = 'block';
    var f = files[filePath];
    var textLines = f.content.split('\\n');
    var rows = [];
    var hlStart = lines ? lines.start : -1;
    var hlEnd = lines ? lines.end : -1;

    for (var i = 0; i < textLines.length; i++) {
      var ln = i + 1;
      var inHl = ln >= hlStart && ln <= hlEnd;
      var inMod = isLineInRanges(ln, f.modifiedRanges);
      var cls = 'code-row' + (inHl ? ' hl' : '') + (inMod ? ' mod' : '');
      var badge = (inHl && ln === hlStart && label)
        ? '<span class="hl-badge">◀ ' + escapeHtmlText(label) + '</span>'
        : '';
      rows.push(
        '<tr class="' + cls + '" id="code-ln-' + ln + '">' +
        '<td class="code-ln">' + ln + '</td>' +
        '<td class="code-txt">' + highlightSyntaxLine(textLines[i], f.language) + badge + '</td>' +
        '</tr>'
      );
    }

    var notice = f.truncated
      ? '<div style="padding:8px 12px;color:var(--muted);border-top:1px solid var(--border);">文件较大，已截取前 ' + textLines.length + ' 行（原始共 ' + f.totalLines + ' 行）</div>'
      : '';
    dom.codeScroll.innerHTML = '<table class="code-table"><tbody>' + rows.join('') + '</tbody></table>' + notice;

    if (hlStart > 0) {
      var targetRow = document.getElementById('code-ln-' + hlStart);
      if (targetRow && targetRow.scrollIntoView) {
        targetRow.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    } else {
      dom.codeScroll.scrollTop = 0;
    }
  }

  function applyTransform() {
    dom.wbCanvas.style.transform = 'translate(' + panX + 'px, ' + panY + 'px) scale(' + zoomScale + ')';
  }

  function fitWhiteboard() {
    zoomScale = 1;
    panX = 0;
    panY = 0;
    var svgEl = dom.wbCanvas.querySelector('svg');
    if (svgEl) {
      svgEl.style.width = '100%';
      svgEl.style.height = '100%';
    }
    applyTransform();
  }

  function extractLogicalNodeId(el) {
    var did = el.getAttribute('data-id');
    if (did) return did;
    var raw = el.id || '';
    var m = raw.match(/^(?:flowchart|state|statediagram|class|classId|er|entity)-(.+?)-\\d+$/);
    return m ? m[1] : raw;
  }

  function parseMapTarget(raw) {
    if (!raw) return null;
    var trimmed = String(raw).trim();
    var m = trimmed.match(/^(.+?):(\\d+)(?:-(\\d+))?$/);
    if (m) {
      var s = parseInt(m[2], 10);
      var e = m[3] ? parseInt(m[3], 10) : s;
      return { file: m[1].trim(), lines: { start: s, end: Math.max(s, e) } };
    }
    return { file: trimmed };
  }

  function decorateSvgInteractivity(asset, focusedNodeId) {
    var svgEl = dom.wbCanvas.querySelector('svg');
    if (!svgEl) return;
    var nodeEls = svgEl.querySelectorAll('.node, g[id^="entity-"], g.statediagram-state');
    var focusTarget = (focusedNodeId || '').trim().toLowerCase();
    var matchedEl = null;

    for (var i = 0; i < nodeEls.length; i++) {
      var el = nodeEls[i];
      el.classList.remove('ra-node-focused', 'ra-dimmed', 'ra-clickable');
      var lid = extractLogicalNodeId(el);
      if (asset.nodeCodeMap && asset.nodeCodeMap[lid]) {
        el.classList.add('ra-clickable');
      }
      if (focusTarget && !matchedEl) {
        if (lid.toLowerCase() === focusTarget) matchedEl = el;
      }
    }
    if (focusTarget && !matchedEl) {
      for (var j = 0; j < nodeEls.length; j++) {
        var lid2 = extractLogicalNodeId(nodeEls[j]).toLowerCase();
        var raw2 = (nodeEls[j].id || '').toLowerCase();
        if ((lid2 && (lid2.indexOf(focusTarget) !== -1 || focusTarget.indexOf(lid2) !== -1)) ||
            raw2.indexOf(focusTarget) !== -1) {
          matchedEl = nodeEls[j];
          break;
        }
      }
    }
    for (var k = 0; k < nodeEls.length; k++) {
      var nEl = nodeEls[k];
      if (matchedEl) {
        if (nEl === matchedEl) nEl.classList.add('ra-node-focused');
        else nEl.classList.add('ra-dimmed');
      }
      (function (element) {
        element.addEventListener('click', function (ev) {
          ev.stopPropagation();
          var nodeId = extractLogicalNodeId(element);
          var rawRef = asset.nodeCodeMap && asset.nodeCodeMap[nodeId];
          var parsed = parseMapTarget(rawRef);
          if (parsed && parsed.file) {
            renderCodeView(parsed.file, parsed.lines, nodeId);
          }
        });
      })(nEl);
    }
  }

  function ensureMermaidCdn() {
    if (window.mermaid) return Promise.resolve(window.mermaid);
    if (mermaidLoaderPromise) return mermaidLoaderPromise;
    mermaidLoaderPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js';
      s.onload = function () { resolve(window.mermaid); };
      s.onerror = reject;
      document.head.appendChild(s);
    });
    return mermaidLoaderPromise;
  }

  function renderWhiteboard(step) {
    var crumbs = (step && step.breadcrumbs) || [];
    var targetKey = manualDiagramKey || (step && step.diagramKey) || (crumbs[crumbs.length - 1] && crumbs[crumbs.length - 1].diagramKey);

    dom.breadcrumbs.innerHTML = '';
    for (var i = 0; i < crumbs.length; i++) {
      if (i > 0) {
        var sep = document.createElement('span');
        sep.className = 'crumb-sep';
        sep.textContent = '›';
        dom.breadcrumbs.appendChild(sep);
      }
      var c = crumbs[i];
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'crumb-btn' + (c.diagramKey === targetKey ? ' active' : '');
      btn.innerHTML = '<span class="crumb-lv">L' + c.level + '</span><span class="crumb-title">' + escapeHtmlText(c.title) + '</span>';
      (function (dKey) {
        btn.addEventListener('click', function () {
          manualDiagramKey = dKey;
          renderWhiteboard(steps[currentIndex]);
        });
      })(c.diagramKey);
      dom.breadcrumbs.appendChild(btn);
    }

    var asset = targetKey ? diagrams[targetKey] : null;
    if (!asset) {
      dom.wbCanvas.innerHTML = '<div class="code-empty">当前步骤暂无白板图示</div>';
      return;
    }

    if (asset.svg) {
      dom.wbCanvas.innerHTML = asset.svg;
      fitWhiteboard();
      decorateSvgInteractivity(asset, step && !manualDiagramKey ? step.focusedNodeId : undefined);
      return;
    }

    // Fallback: try CDN Mermaid render if online, otherwise show source cleanly
    dom.wbCanvas.innerHTML = '<pre class="wb-source-fallback">' + escapeHtmlText(asset.mermaidCode) + '</pre>';
    ensureMermaidCdn().then(function (m) {
      if (!m) return;
      m.initialize({ startOnLoad: false, theme: 'base', securityLevel: 'loose' });
      var id = 'exp-m-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
      return m.render(id, asset.mermaidCode).then(function (res) {
        if (res && res.svg) {
          asset.svg = res.svg;
          dom.wbCanvas.innerHTML = res.svg;
          fitWhiteboard();
          decorateSvgInteractivity(asset, step && !manualDiagramKey ? step.focusedNodeId : undefined);
        }
      });
    }).catch(function () { /* keep readable Mermaid source fallback offline */ });
  }

  function renderDrawer() {
    dom.drawerBody.innerHTML = '';
    var step = steps[currentIndex];
    if (activeTab === 'transcript') {
      var lastChapterTitle = null;
      for (var i = 0; i < steps.length; i++) {
        var s = steps[i];
        var chapTitle = (s.chapter && s.chapter.title) || s.groupTitle;
        if (chapTitle && chapTitle !== lastChapterTitle) {
          lastChapterTitle = chapTitle;
          var chapDiv = document.createElement('div');
          chapDiv.className = 'chapter-pill';
          chapDiv.textContent = chapTitle;
          dom.drawerBody.appendChild(chapDiv);
        }
        var card = document.createElement('div');
        card.className = 'seg-item' + (i === currentIndex ? ' active' : '');
        card.id = 'seg-card-' + i;
        var locStr = s.code && s.code.file ? (s.code.file.split('/').pop() + (s.code.lines ? ':' + s.code.lines.start : '')) : '';
        card.innerHTML =
          '<div class="seg-item-meta"><span>#' + (i + 1) + '</span><span>' + escapeHtmlText(locStr) + '</span></div>' +
          '<div class="seg-item-text">' + escapeHtmlText(s.spokenText) + '</div>';
        (function (idx) {
          card.addEventListener('click', function () {
            jumpToStep(idx, true);
          });
        })(i);
        dom.drawerBody.appendChild(card);
      }
      var activeCard = document.getElementById('seg-card-' + currentIndex);
      if (activeCard && activeCard.scrollIntoView) {
        activeCard.scrollIntoView({ block: 'nearest' });
      }
    } else if (activeTab === 'chain') {
      var chain = step && step.callChain;
      if (!chain || !chain.nodes || !chain.nodes.length) {
        dom.drawerBody.innerHTML = '<div class="code-empty">当前步骤暂无主调用链数据</div>';
        return;
      }
      var hdr = document.createElement('div');
      hdr.className = 'chapter-pill';
      hdr.textContent = chain.title;
      dom.drawerBody.appendChild(hdr);

      for (var j = 0; j < chain.nodes.length; j++) {
        var node = chain.nodes[j];
        var cn = document.createElement('div');
        cn.className = 'chain-node' + (j === chain.activeIndex ? ' active' : '');
        cn.innerHTML =
          '<div class="chain-sym">' + (j === chain.activeIndex ? '▶ ' : '') + escapeHtmlText(node.symbol) + '</div>' +
          '<div class="chain-loc">' + escapeHtmlText(node.file) + ':' + node.line + '</div>' +
          (node.role ? '<div class="chain-role">' + escapeHtmlText(node.role) + '</div>' : '');
        (function (nd) {
          cn.addEventListener('click', function () {
            renderCodeView(nd.file, { start: nd.line, end: nd.endLine || (nd.line + 6) }, nd.symbol);
          });
        })(node);
        dom.drawerBody.appendChild(cn);
      }
    } else if (activeTab === 'notes') {
      if (!notes.length) {
        dom.drawerBody.innerHTML = '<div class="code-empty">本次导读未记录 Review 批注 / Action</div>';
        return;
      }
      for (var n = 0; n < notes.length; n++) {
        var note = notes[n];
        var nc = document.createElement('div');
        nc.className = 'note-card';
        nc.innerHTML =
          '<div class="note-top">' +
          '<span class="sev ' + escapeHtmlText(note.severity) + '">' + escapeHtmlText(note.severity) + '</span>' +
          '<button type="button" class="note-loc-btn">' + escapeHtmlText(note.file) + ':' + note.line + '</button>' +
          '</div>' +
          '<div>' + escapeHtmlText(note.body) + '</div>';
        (function (nt) {
          var btn = nc.querySelector('.note-loc-btn');
          if (btn) {
            btn.addEventListener('click', function () {
              renderCodeView(nt.file, { start: Math.max(1, nt.line), end: Math.max(1, nt.line + 4) }, nt.severity.toUpperCase());
            });
          }
        })(note);
        dom.drawerBody.appendChild(nc);
      }
    }
  }

  function stopAudioAndSpeech() {
    if (currentAudio) {
      try {
        currentAudio.onended = null;
        currentAudio.onerror = null;
        currentAudio.pause();
      } catch (_) {}
      currentAudio = null;
    }
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
    if (window.speechSynthesis) {
      try { window.speechSynthesis.cancel(); } catch (_) {}
    }
  }

  function updatePlayerChrome() {
    var step = steps[currentIndex];
    dom.btnPlay.textContent = playing ? '⏸ 暂停' : '▶ 播放';
    dom.btnMute.textContent = muted ? '🔇 已静音' : '🔊 有声';
    if (!step) {
      dom.subtitleText.textContent = '无可播放片段';
      dom.subtitleStatus.textContent = '0 / 0';
      dom.progressFill.style.width = '0%';
      return;
    }
    dom.subtitleText.textContent = step.spokenText || '（无语音文本）';
    var chap = (step.chapter && step.chapter.title) ? (step.chapter.title + ' · ') : '';
    dom.subtitleStatus.textContent = chap + (currentIndex + 1) + ' / ' + steps.length;
    var pct = steps.length <= 1 ? 100 : ((currentIndex / (steps.length - 1)) * 100);
    dom.progressFill.style.width = pct + '%';
  }

  function advanceAfterSegment(token) {
    if (token !== playToken || !playing) return;
    if (currentIndex + 1 < steps.length) {
      jumpToStep(currentIndex + 1, true);
    } else {
      playing = false;
      updatePlayerChrome();
    }
  }

  function playCurrentStep() {
    stopAudioAndSpeech();
    var token = ++playToken;
    var step = steps[currentIndex];
    if (!step) {
      playing = false;
      updatePlayerChrome();
      return;
    }

    if (muted) {
      var silentMs = Math.max(1200, Math.min(9000, Math.round((step.spokenText.length * 165) / playbackRate)));
      fallbackTimer = setTimeout(function () { advanceAfterSegment(token); }, silentMs);
      return;
    }

    if (step.audioBase64 && !step.fallbackTextOnly) {
      try {
        var mime = step.mimeType || 'audio/mpeg';
        var audio = new Audio('data:' + mime + ';base64,' + step.audioBase64);
        audio.playbackRate = playbackRate;
        currentAudio = audio;
        audio.onended = function () { advanceAfterSegment(token); };
        audio.onerror = function () { speakViaBrowserOrTimer(step, token); };
        var playPromise = audio.play();
        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise.catch(function () {
            speakViaBrowserOrTimer(step, token);
          });
        }
        return;
      } catch (_) {}
    }

    speakViaBrowserOrTimer(step, token);
  }

  function speakViaBrowserOrTimer(step, token) {
    if (token !== playToken || !playing) return;
    if (window.speechSynthesis && step.spokenText) {
      try {
        var u = new SpeechSynthesisUtterance(step.spokenText);
        u.lang = 'zh-CN';
        u.rate = playbackRate;
        u.onend = function () { advanceAfterSegment(token); };
        u.onerror = function () { advanceAfterSegment(token); };
        window.speechSynthesis.speak(u);
        return;
      } catch (_) {}
    }
    var ms = Math.max(1500, Math.min(10000, Math.round((step.spokenText.length * 180) / playbackRate)));
    fallbackTimer = setTimeout(function () { advanceAfterSegment(token); }, ms);
  }

  function jumpToStep(index, autoPlay) {
    if (!steps.length) return;
    currentIndex = Math.max(0, Math.min(index, steps.length - 1));
    manualDiagramKey = null;
    var step = steps[currentIndex];
    if (step.code && step.code.file) {
      renderCodeView(step.code.file, step.code.lines, step.code.label);
    }
    renderWhiteboard(step);
    renderDrawer();
    if (autoPlay !== undefined) {
      playing = Boolean(autoPlay);
    }
    updatePlayerChrome();
    if (playing) {
      playCurrentStep();
    } else {
      stopAudioAndSpeech();
    }
  }

  // Event bindings
  dom.btnPlay.addEventListener('click', function () {
    if (!steps.length) return;
    if (playing) {
      playing = false;
      ++playToken;
      stopAudioAndSpeech();
      updatePlayerChrome();
    } else {
      playing = true;
      updatePlayerChrome();
      playCurrentStep();
    }
  });
  dom.btnPrev.addEventListener('click', function () { jumpToStep(currentIndex - 1, playing); });
  dom.btnNext.addEventListener('click', function () { jumpToStep(currentIndex + 1, playing); });
  dom.btnRestart.addEventListener('click', function () { jumpToStep(0, true); });
  dom.btnMute.addEventListener('click', function () {
    muted = !muted;
    updatePlayerChrome();
    if (playing) playCurrentStep();
  });
  dom.rateSelect.addEventListener('change', function () {
    playbackRate = parseFloat(dom.rateSelect.value) || 1.0;
    if (currentAudio) currentAudio.playbackRate = playbackRate;
  });
  dom.checkpointSelect.addEventListener('change', function () {
    if (dom.checkpointSelect.value !== '') {
      jumpToStep(parseInt(dom.checkpointSelect.value, 10) || 0, true);
    }
  });
  dom.fileSelect.addEventListener('change', function () {
    if (dom.fileSelect.value) {
      renderCodeView(dom.fileSelect.value, null, null);
    }
  });
  dom.progressBar.addEventListener('click', function (ev) {
    if (!steps.length) return;
    var rect = dom.progressBar.getBoundingClientRect();
    var ratio = Math.max(0, Math.min(1, (ev.clientX - rect.left) / Math.max(1, rect.width)));
    var idx = Math.round(ratio * (steps.length - 1));
    jumpToStep(idx, playing);
  });

  dom.btnSwap.addEventListener('click', function () {
    dom.workspace.classList.toggle('swapped');
    if (monacoEditor) monacoEditor.layout();
  });
  dom.btnDrawer.addEventListener('click', function () {
    dom.drawer.classList.toggle('hidden');
    dom.btnDrawer.classList.toggle('active', !dom.drawer.classList.contains('hidden'));
    if (monacoEditor) monacoEditor.layout();
  });
  dom.btnTheme.addEventListener('click', function () {
    var htmlEl = document.documentElement;
    var next = htmlEl.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    htmlEl.setAttribute('data-theme', next);
    if (monacoReady && window.monaco) {
      window.monaco.editor.setTheme(next === 'dark' ? 'vs-dark' : 'vs');
    }
  });

  var tabs = document.querySelectorAll('.drawer-tab');
  for (var t = 0; t < tabs.length; t++) {
    (function (tabEl) {
      tabEl.addEventListener('click', function () {
        for (var x = 0; x < tabs.length; x++) tabs[x].classList.remove('active');
        tabEl.classList.add('active');
        activeTab = tabEl.getAttribute('data-tab') || 'transcript';
        renderDrawer();
      });
    })(tabs[t]);
  }

  // Pan / Zoom controls
  function zoomAt(factor, cx, cy) {
    var nextScale = Math.max(0.25, Math.min(5, zoomScale * factor));
    var ratio = nextScale / zoomScale;
    if (ratio === 1) return;
    panX = cx - (cx - panX) * ratio;
    panY = cy - (cy - panY) * ratio;
    zoomScale = nextScale;
    applyTransform();
  }

  dom.btnZoomIn.addEventListener('click', function () {
    var rect = dom.wbStageWrap.getBoundingClientRect();
    zoomAt(1.2, rect.width / 2, rect.height / 2);
  });
  dom.btnZoomOut.addEventListener('click', function () {
    var rect = dom.wbStageWrap.getBoundingClientRect();
    zoomAt(1 / 1.2, rect.width / 2, rect.height / 2);
  });
  dom.btnFit.addEventListener('click', fitWhiteboard);

  var draggingWb = false;
  var startX = 0;
  var startY = 0;
  dom.wbStageWrap.addEventListener('mousedown', function (e) {
    if (e.target && e.target.closest && e.target.closest('.wb-controls')) return;
    draggingWb = true;
    startX = e.clientX - panX;
    startY = e.clientY - panY;
  });
  window.addEventListener('mousemove', function (e) {
    if (!draggingWb) return;
    panX = e.clientX - startX;
    panY = e.clientY - startY;
    applyTransform();
  });
  window.addEventListener('mouseup', function () { draggingWb = false; });
  dom.wbStageWrap.addEventListener('wheel', function (e) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      var clampedDelta = Math.max(-60, Math.min(60, e.deltaY));
      var factor = Math.exp(-clampedDelta * 0.012);
      var rect = dom.wbStageWrap.getBoundingClientRect();
      zoomAt(factor, e.clientX - rect.left, e.clientY - rect.top);
    } else {
      panX -= e.deltaX;
      panY -= e.deltaY;
      applyTransform();
    }
  }, { passive: false });

  // Splitter resize
  var draggingSplit = false;
  dom.splitter.addEventListener('mousedown', function (e) {
    e.preventDefault();
    draggingSplit = true;
    dom.splitter.classList.add('dragging');
  });
  window.addEventListener('mousemove', function (e) {
    if (!draggingSplit) return;
    var splitRect = dom.workspace.querySelector('.split-main').getBoundingClientRect();
    var swapped = dom.workspace.classList.contains('swapped');
    var relX = swapped ? (splitRect.right - e.clientX) : (e.clientX - splitRect.left);
    var pct = Math.max(20, Math.min(80, (relX / Math.max(1, splitRect.width)) * 100));
    dom.codePane.style.flex = '0 0 ' + pct.toFixed(1) + '%';
  });
  window.addEventListener('mouseup', function () {
    if (draggingSplit) {
      draggingSplit = false;
      dom.splitter.classList.remove('dragging');
      if (monacoEditor) monacoEditor.layout();
    }
  });

  // Keyboard shortcuts
  window.addEventListener('keydown', function (e) {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.code === 'Space') {
      e.preventDefault();
      dom.btnPlay.click();
    } else if (e.code === 'ArrowLeft') {
      e.preventDefault();
      dom.btnPrev.click();
    } else if (e.code === 'ArrowRight') {
      e.preventDefault();
      dom.btnNext.click();
    }
  });

  populateHeaderAndSelectors();
  initMonacoEditor();
  if (steps.length > 0) {
    jumpToStep(0, false);
  } else {
    renderDrawer();
    updatePlayerChrome();
  }
})();
</script>
</body>
</html>`;
}
