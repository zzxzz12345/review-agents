import type { LineRange } from '../shared/protocol';

export const MAX_HIGHLIGHT_LINES = 10;

/**
 * Clamp a 1-based inclusive line range to at most `maxLines` lines
 * so highlighted code always fits comfortably on a single editor screen.
 */
export function clampHighlightRange(
  lines: LineRange,
  maxLines = MAX_HIGHLIGHT_LINES
): LineRange {
  const safeMax = Math.max(1, Math.floor(maxLines));
  const start = Math.max(1, Math.floor(lines.start));
  const rawEnd = Math.max(start, Math.floor(lines.end));
  return {
    start,
    end: Math.min(rawEnd, start + safeMax - 1),
  };
}

const EXPLICIT_HEADER_LABEL_RE = /(?:import|导入|依赖|引入|require|header|头部)/i;
const SYMBOL_DECL_RE =
  /^(?:export\s+(?:default\s+|async\s+)?|abstract\s+|pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:class|interface|struct|enum|type|def|function|func|fn)\s+[A-Za-z_]/;

function stripTrailingLineComment(line: string): string {
  // Best-effort strip of # or // comments outside simple quotes
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble && line[i - 1] !== '\\') {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle && line[i - 1] !== '\\') {
      inDouble = !inDouble;
    } else if (!inSingle && !inDouble) {
      if (ch === '#') {
        return line.slice(0, i);
      }
      if (ch === '/' && line[i + 1] === '/') {
        return line.slice(0, i);
      }
    }
  }
  return line;
}

function deltaParenDepth(line: string): number {
  const code = stripTrailingLineComment(line);
  let delta = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === "'" && !inDouble && code[i - 1] !== '\\') {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle && code[i - 1] !== '\\') {
      inDouble = !inDouble;
    } else if (!inSingle && !inDouble) {
      if (ch === '(') {
        delta += 1;
      } else if (ch === ')') {
        delta -= 1;
      }
    }
  }
  return delta;
}

function deltaBraceDepth(line: string): number {
  const code = stripTrailingLineComment(line);
  let delta = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === "'" && !inDouble && code[i - 1] !== '\\') {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle && code[i - 1] !== '\\') {
      inDouble = !inDouble;
    } else if (!inSingle && !inDouble) {
      if (ch === '{') {
        delta += 1;
      } else if (ch === '}') {
        delta -= 1;
      }
    }
  }
  return delta;
}

/**
 * If an LLM guesses `lines="1-8"` (or falls back to file top) and lands solely on
 * top-of-file imports / comments / module docstrings, relocate the highlight to
 * either `options.preferredLines` (e.g., a known modified hunk) or the first real
 * code/symbol declaration past the top boilerplate block.
 */
export function recalibrateTopBoilerplateRange(
  documentHeadLines: string[],
  requested: LineRange,
  options: {
    label?: string;
    preferredLines?: LineRange;
    maxLines?: number;
    totalLineCount?: number;
  } = {}
): LineRange {
  const maxLines = Math.max(1, Math.floor(options.maxLines ?? MAX_HIGHLIGHT_LINES));
  const rawClamped = clampHighlightRange(requested, maxLines);

  if (documentHeadLines.length === 0) {
    return rawClamped;
  }

  const total = Math.max(documentHeadLines.length, options.totalLineCount ?? 0);
  const clamped: LineRange = {
    start: Math.min(rawClamped.start, total),
    end: Math.min(rawClamped.end, total),
  };

  if (clamped.start > 5 || total <= clamped.end) {
    return clamped;
  }

  if (options.label && EXPLICIT_HEADER_LABEL_RE.test(options.label)) {
    return clamped;
  }

  let inBlockComment = false;
  let docstringDelim: '"""' | "'''" | null = null;
  let parenImportDepth = 0;
  let braceImportDepth = 0;
  let firstRealCodeLine: number | undefined;

  for (let i = 0; i < documentHeadLines.length; i++) {
    const raw = documentHeadLines[i];
    const trimmed = raw.trim();
    const lineNum = i + 1;

    if (docstringDelim) {
      if (raw.includes(docstringDelim)) {
        docstringDelim = null;
      }
      continue;
    }

    if (inBlockComment) {
      if (trimmed.includes('*/')) {
        inBlockComment = false;
      }
      continue;
    }

    if (parenImportDepth > 0) {
      parenImportDepth += deltaParenDepth(raw);
      continue;
    }

    if (braceImportDepth > 0) {
      braceImportDepth += deltaBraceDepth(raw);
      continue;
    }

    if (trimmed === '') {
      continue;
    }

    if (trimmed.startsWith('/*')) {
      if (!trimmed.slice(2).includes('*/')) {
        inBlockComment = true;
      }
      continue;
    }

    if (
      trimmed.startsWith('//') ||
      trimmed.startsWith('--') ||
      (trimmed.startsWith('#') && !/^#\[/.test(trimmed))
    ) {
      continue;
    }

    if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
      const delim = trimmed.startsWith('"""') ? '"""' : "'''";
      if (trimmed.indexOf(delim, 3) === -1) {
        docstringDelim = delim;
      }
      continue;
    }

    if (
      /^['"]use strict['"];?$/.test(trimmed) ||
      /^package\s+[A-Za-z0-9_.]+;?$/.test(trimmed) ||
      /^using\s+(?:static\s+)?[A-Za-z0-9_.= ]+;$/.test(trimmed) ||
      /^use\s+[A-Za-z0-9_:{},*\s]+;$/.test(trimmed) ||
      /^#pragma\s+once\b/.test(trimmed)
    ) {
      continue;
    }

    // Python: `from pkg import ...` or `import ...`
    if (/^from\s+[A-Za-z0-9_.]+\s+import\b/.test(trimmed)) {
      const depth = deltaParenDepth(raw);
      if (depth > 0) {
        parenImportDepth = depth;
      }
      continue;
    }

    // Go / Python / JS `import` statements
    if (/^import\b/.test(trimmed)) {
      const pDepth = deltaParenDepth(raw);
      if (pDepth > 0) {
        parenImportDepth = pDepth;
      }
      const bDepth = deltaBraceDepth(raw);
      if (bDepth > 0) {
        braceImportDepth = bDepth;
      }
      continue;
    }

    // JS/TS re-exports or require statements at file top
    if (
      /^export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\b/.test(trimmed) ||
      /^export\s+(?:type\s+)?\{[^}]*$/.test(trimmed) ||
      /^(?:const|let|var)\s+[\w{},\s:]+\s*=\s*require\s*\(/.test(trimmed)
    ) {
      const bDepth = deltaBraceDepth(raw);
      if (bDepth > 0) {
        braceImportDepth = bDepth;
      }
      continue;
    }

    firstRealCodeLine = lineNum;
    break;
  }

  // Not pure top-of-file boilerplate if the requested range already touches real code,
  // or if no real code exists in the inspected head lines.
  if (firstRealCodeLine === undefined || clamped.end >= firstRealCodeLine) {
    return clamped;
  }

  if (
    options.preferredLines &&
    options.preferredLines.start > clamped.end &&
    options.preferredLines.start <= total
  ) {
    const pref = clampHighlightRange(options.preferredLines, maxLines);
    return {
      start: Math.min(pref.start, total),
      end: Math.min(pref.end, total),
    };
  }

  let anchorLine = firstRealCodeLine;
  const searchLimit = Math.min(documentHeadLines.length, firstRealCodeLine - 1 + 30);
  for (let idx = firstRealCodeLine - 1; idx < searchLimit; idx++) {
    const t = documentHeadLines[idx].trim();
    if (SYMBOL_DECL_RE.test(t)) {
      anchorLine = idx + 1;
      break;
    }
  }

  const anchorEnd = Math.min(total, anchorLine + Math.min(7, maxLines - 1));
  return clampHighlightRange({ start: anchorLine, end: anchorEnd }, maxLines);
}
