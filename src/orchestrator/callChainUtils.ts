import type { CallChainNode } from '../shared/protocol';

/**
 * Parse `<call_chain>` inner body (pipe-delimited lines or JSON array fallback)
 * into structured nodes and an active node index.
 */
export function parseCallChainBody(rawBody: string): {
  nodes: CallChainNode[];
  activeIndex: number;
} {
  let cleaned = rawBody.trim();
  cleaned = cleaned.replace(/^```(?:[a-z]+)?\s*\r?\n?/i, '');
  cleaned = cleaned.replace(/\r?\n?```\s*$/i, '').trim();
  if (!cleaned) {
    return { nodes: [], activeIndex: -1 };
  }

  if (cleaned.startsWith('[')) {
    try {
      const arr = JSON.parse(cleaned) as Array<Record<string, unknown>>;
      if (Array.isArray(arr)) {
        const nodes: CallChainNode[] = [];
        let activeIndex = -1;
        for (let i = 0; i < arr.length; i++) {
          const item = arr[i];
          if (!item || typeof item !== 'object') {
            continue;
          }
          const symbol = String(item.symbol ?? item.name ?? '').trim();
          const rawFile = String(item.file ?? '').trim();
          if (!symbol && !rawFile) {
            continue;
          }
          const parsedLoc = parseFileAndLine(rawFile, Number(item.line ?? 0) || undefined);
          const endLine =
            typeof item.endLine === 'number' && item.endLine > 0
              ? item.endLine
              : parsedLoc.endLine;
          const node: CallChainNode = {
            id: `cc-${nodes.length}`,
            symbol: symbol || parsedLoc.file || `Step ${nodes.length + 1}`,
            file: parsedLoc.file,
            line: parsedLoc.line,
            endLine,
            role: typeof item.role === 'string' ? item.role.trim() : undefined,
          };
          if (item.active === true) {
            activeIndex = nodes.length;
          }
          nodes.push(node);
        }
        return {
          nodes,
          activeIndex:
            nodes.length === 0 ? -1 : activeIndex >= 0 ? activeIndex : nodes.length - 1,
        };
      }
    } catch {
      // Fall through to line-by-line parser
    }
  }

  const nodes: CallChainNode[] = [];
  let activeIndex = -1;

  for (const rawLine of cleaned.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('//') || line.startsWith('#')) {
      continue;
    }

    // Strip optional list prefixes like "1. " or "- "
    line = line.replace(/^(?:\d+[.)]\s+|-\s+)/, '').trim();

    let isActive = false;
    if (/^[*▶→>]\s*/.test(line)) {
      isActive = true;
      line = line.replace(/^[*▶→>]+\s*/, '').trim();
    }

    const parts = line.split('|').map((p) => p.trim());
    const rawSymbol = parts[0] ?? '';
    const rawLoc = parts[1] ?? '';
    const role = parts.slice(2).join(' | ').trim() || undefined;

    if (!rawSymbol && !rawLoc) {
      continue;
    }

    const parsedLoc = parseFileAndLine(rawLoc);
    const symbol = rawSymbol.replace(/^[*▶]+\s*/, '').trim() || parsedLoc.file;

    if (isActive) {
      activeIndex = nodes.length;
    }

    nodes.push({
      id: `cc-${nodes.length}`,
      symbol,
      file: parsedLoc.file,
      line: parsedLoc.line,
      endLine: parsedLoc.endLine,
      role,
    });
  }

  return {
    nodes,
    activeIndex:
      nodes.length === 0 ? -1 : activeIndex >= 0 ? activeIndex : nodes.length - 1,
  };
}

/**
 * Extract the short method/function/class identifier from qualified symbol labels
 * such as `AuthService.refreshToken()`, `AuthService::refresh`, or `verifyToken`.
 */
export function extractShortSymbolName(symbol: string): string {
  const cleaned = symbol
    .replace(/\([^)]*\).*$/, '')
    .replace(/<[^>]*>/g, '')
    .trim();
  if (!cleaned) {
    return '';
  }
  // Route strings like "POST /auth/refresh" do not correspond to a single symbol declaration
  if (/\s+\//.test(cleaned) || cleaned.startsWith('/')) {
    return '';
  }
  const segments = cleaned.split(/[.:/#]+/).filter(Boolean);
  const last = segments[segments.length - 1] ?? '';
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(last) ? last : '';
}

/**
 * Calibrate a hinted line number against real file contents by finding matching symbol
 * declarations near `hintLine` (or the first matching declaration in the file).
 */
export function calibrateNodeLineFromContent(
  content: string,
  symbol: string,
  hintLine?: number
): { line: number; verified: boolean } {
  const fileLines = content.split(/\r?\n/);
  const totalLines = Math.max(1, fileLines.length);
  const clampedHint = Math.max(1, Math.min(totalLines, Math.floor(hintLine || 1)));
  const ident = extractShortSymbolName(symbol);

  if (!ident) {
    return { line: clampedHint, verified: false };
  }

  const escaped = escapeRegExp(ident);
  const declPatterns = [
    new RegExp(
      `^\\s*(?:export\\s+(?:default\\s+)?)?(?:abstract\\s+)?(?:class|interface|struct|enum)\\s+${escaped}\\b`
    ),
    new RegExp(`^\\s*type\\s+${escaped}\\s+(?:struct|interface|=)`),
    new RegExp(`^\\s*(?:async\\s+)?def\\s+${escaped}\\s*\\(`),
    new RegExp(
      `^\\s*(?:export\\s+(?:default\\s+)?)?(?:async\\s+)?function\\s+${escaped}\\s*[<(]`
    ),
    new RegExp(
      `^\\s*(?:public|private|protected|static|async|override|readonly|\\s)*${escaped}\\s*(?:<[^>]+>)?\\s*\\(`
    ),
    new RegExp(`^\\s*func\\s+(?:\\([^)]+\\)\\s+)?${escaped}\\s*\\(`),
    new RegExp(`^\\s*(?:pub\\s+)?(?:async\\s+)?fn\\s+${escaped}\\s*[<(]`),
    new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${escaped}\\s*=`),
  ];

  const matches: number[] = [];
  for (let i = 0; i < fileLines.length; i++) {
    const lineText = fileLines[i];
    if (declPatterns.some((re) => re.test(lineText))) {
      matches.push(i + 1);
    }
  }

  if (matches.length === 0) {
    return { line: clampedHint, verified: false };
  }

  if (!hintLine || hintLine <= 1) {
    return { line: matches[0], verified: true };
  }

  let bestLine = matches[0];
  let bestDist = Math.abs(bestLine - clampedHint);
  for (const m of matches.slice(1)) {
    const dist = Math.abs(m - clampedHint);
    if (dist < bestDist) {
      bestDist = dist;
      bestLine = m;
    }
  }

  return { line: bestLine, verified: true };
}

/**
 * Filter out unit tests, mocks, fixtures, and build/vendor paths from incoming callers.
 */
export function isNoiseCallerPath(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, '/').toLowerCase();
  return (
    /(^|\/)(__tests__|tests?|spec|__mocks__|mocks?|fixtures?|node_modules|dist|build|coverage)(\/|$)/.test(
      norm
    ) || /\.(test|spec|mock)\.[cm]?[jt]sx?$|\.(test|spec)\.py$|_test\.(go|py|rs)$/i.test(norm)
  );
}

/**
 * Match the active call-chain node corresponding to the given file and optional line number.
 */
export function matchActiveCallChainNode(
  nodes: CallChainNode[],
  file: string,
  line?: number
): number {
  const normTarget = normalizeRelPath(file);
  if (!normTarget) {
    return -1;
  }

  const candidateIndices: number[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const nodeFile = normalizeRelPath(nodes[i].file);
    if (!nodeFile) {
      continue;
    }
    if (
      nodeFile === normTarget ||
      normTarget.endsWith(`/${nodeFile}`) ||
      nodeFile.endsWith(`/${normTarget}`)
    ) {
      candidateIndices.push(i);
    }
  }

  if (candidateIndices.length === 0) {
    return -1;
  }
  if (candidateIndices.length === 1 || !line || line <= 0) {
    return candidateIndices[candidateIndices.length - 1];
  }

  for (const idx of candidateIndices) {
    const node = nodes[idx];
    const end = node.endLine ?? node.line + 12;
    if (line >= node.line && line <= end) {
      return idx;
    }
  }

  let bestIdx = candidateIndices[0];
  let bestDist = Math.abs(nodes[bestIdx].line - line);
  for (const idx of candidateIndices.slice(1)) {
    const dist = Math.abs(nodes[idx].line - line);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = idx;
    }
  }
  return bestIdx;
}

function parseFileAndLine(
  raw: string,
  fallbackLine?: number
): { file: string; line: number; endLine?: number } {
  const clean = normalizeRelPath(raw);
  if (!clean) {
    return { file: '', line: Math.max(1, fallbackLine ?? 1) };
  }
  const match = clean.match(/^(.+?):(\d+)(?:-(\d+))?$/);
  if (match) {
    const start = Math.max(1, Number.parseInt(match[2], 10) || 1);
    const parsedEnd = match[3] ? Number.parseInt(match[3], 10) : undefined;
    return {
      file: normalizeRelPath(match[1]),
      line: start,
      endLine: parsedEnd && parsedEnd >= start ? parsedEnd : undefined,
    };
  }
  return {
    file: clean,
    line: Math.max(1, fallbackLine ?? 1),
  };
}

function normalizeRelPath(raw: string): string {
  return raw.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/^\.\//, '');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
