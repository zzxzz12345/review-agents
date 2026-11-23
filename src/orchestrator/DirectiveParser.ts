import type {
  CallChainDirective,
  ChapterDirective,
  CodeGotoDirective,
  CodeViewMode,
  Directive,
  LineRange,
  ReviewNoteDirective,
  UtteranceSegment,
  WalkthroughDoneDirective,
  WbClearDirective,
  WbFocusDirective,
  WbPopDirective,
  WbRenderDirective,
  WbRenderMode,
} from '../shared/protocol';
import { parseCallChainBody } from './callChainUtils';

const KNOWN_TAGS = [
  'chapter',
  'wb_render',
  'wb_focus',
  'wb_pop',
  'wb_clear',
  'code_goto',
  'review_note',
  'action_item',
  'call_chain',
  'walkthrough_done',
] as const;

const BLOCK_TAGS = new Set<string>([
  'wb_render',
  'review_note',
  'action_item',
  'call_chain',
]);

type KnownTag = (typeof KNOWN_TAGS)[number];

export class DirectiveParser {
  private turnId = 0;
  private segSeq = 0;
  private rawBuffer = '';
  private textBuffer = '';
  private pendingDirectives: Directive[] = [];
  private activeBlockTag: {
    name: KnownTag;
    attrs: Record<string, string>;
    body: string;
  } | null = null;

  constructor(turnId = 1) {
    this.turnId = turnId;
  }

  public reset(turnId: number): void {
    this.turnId = turnId;
    this.segSeq = 0;
    this.rawBuffer = '';
    this.textBuffer = '';
    this.pendingDirectives = [];
    this.activeBlockTag = null;
  }

  public feed(chunk: string): UtteranceSegment[] {
    if (!chunk) {
      return [];
    }
    this.rawBuffer += chunk;
    const emitted: UtteranceSegment[] = [];

    this.processRawBuffer(emitted);
    this.extractReadySentences(false, emitted);

    return emitted;
  }

  public flush(): UtteranceSegment[] {
    const emitted: UtteranceSegment[] = [];

    // If an unclosed block tag remains at EOF, recover cleanly
    if (this.activeBlockTag) {
      this.activeBlockTag.body += this.rawBuffer;
      this.rawBuffer = '';
      const dir = this.buildDirective(
        this.activeBlockTag.name,
        this.activeBlockTag.attrs,
        this.activeBlockTag.body
      );
      if (dir) {
        this.pendingDirectives.push(dir);
      }
      this.activeBlockTag = null;
    } else if (this.rawBuffer) {
      this.textBuffer += this.rawBuffer;
      this.rawBuffer = '';
    }

    this.extractReadySentences(true, emitted);

    if (this.pendingDirectives.length > 0) {
      emitted.push({
        segmentId: this.nextSegmentId(),
        turnId: this.turnId,
        spokenText: '',
        directivesBefore: this.pendingDirectives.splice(0),
        directivesAfter: [],
      });
    }

    return emitted;
  }

  private nextSegmentId(): string {
    this.segSeq += 1;
    return `t${this.turnId}-s${this.segSeq}`;
  }

  private processRawBuffer(emitted: UtteranceSegment[]): void {
    while (this.rawBuffer.length > 0) {
      if (this.activeBlockTag) {
        const closeTag = `</${this.activeBlockTag.name}>`;
        const closeIdx = this.rawBuffer.indexOf(closeTag);
        if (closeIdx === -1) {
          // Keep tail that might be a partial closing tag
          const safeLen = Math.max(0, this.rawBuffer.length - closeTag.length);
          if (safeLen > 0) {
            this.activeBlockTag.body += this.rawBuffer.slice(0, safeLen);
            this.rawBuffer = this.rawBuffer.slice(safeLen);
          }
          return;
        }
        this.activeBlockTag.body += this.rawBuffer.slice(0, closeIdx);
        this.rawBuffer = this.rawBuffer.slice(closeIdx + closeTag.length);
        const directive = this.buildDirective(
          this.activeBlockTag.name,
          this.activeBlockTag.attrs,
          this.activeBlockTag.body
        );
        this.activeBlockTag = null;
        if (directive) {
          this.onDirectiveParsed(directive, emitted);
        }
        continue;
      }

      const ltIdx = this.rawBuffer.indexOf('<');
      if (ltIdx === -1) {
        this.textBuffer += this.rawBuffer;
        this.rawBuffer = '';
        return;
      }

      if (ltIdx > 0) {
        this.textBuffer += this.rawBuffer.slice(0, ltIdx);
        this.rawBuffer = this.rawBuffer.slice(ltIdx);
      }

      // Now rawBuffer starts with '<'
      const tagProbe = inspectPotentialTag(this.rawBuffer);
      if (tagProbe.kind === 'not-a-tag') {
        this.textBuffer += '<';
        this.rawBuffer = this.rawBuffer.slice(1);
        continue;
      }
      if (tagProbe.kind === 'incomplete') {
        return;
      }

      // We have a complete opening or closing tag at rawBuffer[0 .. tagProbe.endIdx]
      const rawTag = this.rawBuffer.slice(0, tagProbe.endIdx + 1);
      this.rawBuffer = this.rawBuffer.slice(tagProbe.endIdx + 1);

      if (tagProbe.isClosing) {
        // Ignore stray closing tags for self-closing directives
        continue;
      }

      const tagName = tagProbe.name;
      const attrs = parseAttributes(tagProbe.attrText);

      if (BLOCK_TAGS.has(tagName) && !tagProbe.selfClosing) {
        this.activeBlockTag = {
          name: tagName,
          attrs,
          body: '',
        };
      } else {
        const directive = this.buildDirective(tagName, attrs, '');
        if (directive) {
          this.onDirectiveParsed(directive, emitted);
        }
      }
    }
  }

  private onDirectiveParsed(
    directive: Directive,
    emitted: UtteranceSegment[]
  ): void {
    // If we already accumulated a substantial sentence before this directive,
    // flush that sentence first so the directive runs right before the NEXT sentence.
    const trimmed = this.textBuffer.trim();
    if (trimmed.length >= 6) {
      this.extractReadySentences(true, emitted);
    }
    this.pendingDirectives.push(directive);
  }

  private extractReadySentences(
    forceFlush: boolean,
    emitted: UtteranceSegment[]
  ): void {
    while (this.textBuffer.length > 0) {
      const splitIdx = findSentenceBoundary(this.textBuffer, forceFlush);
      if (splitIdx === -1) {
        return;
      }

      const rawSlice = this.textBuffer.slice(0, splitIdx);
      this.textBuffer = this.textBuffer.slice(splitIdx);
      const cleaned = normalizeSpokenText(rawSlice);

      if (!cleaned) {
        continue;
      }

      emitted.push({
        segmentId: this.nextSegmentId(),
        turnId: this.turnId,
        spokenText: cleaned,
        directivesBefore: this.pendingDirectives.splice(0),
        directivesAfter: [],
      });
    }
  }

  private buildDirective(
    name: KnownTag,
    attrs: Record<string, string>,
    body: string
  ): Directive | null {
    switch (name) {
      case 'chapter': {
        const index = Number.parseInt(attrs.index ?? '1', 10) || 1;
        const total = Number.parseInt(attrs.total ?? '1', 10) || 1;
        const title = (attrs.title ?? '').trim() || `Chapter ${index}`;
        const d: ChapterDirective = { type: 'chapter', index, total, title };
        return d;
      }
      case 'wb_render': {
        const mermaidCode = sanitizeMermaidCode(body);
        if (!mermaidCode) {
          return null;
        }
        let nodeCodeMap: Record<string, string> | undefined;
        if (attrs.map) {
          try {
            const parsed = JSON.parse(attrs.map);
            if (parsed && typeof parsed === 'object') {
              nodeCodeMap = parsed as Record<string, string>;
            }
          } catch {
            // ignore invalid JSON map attribute
          }
        }
        const rawMode = (attrs.mode ?? '').trim().toLowerCase();
        const mode: WbRenderMode =
          rawMode === 'update' || rawMode === 'rewrite'
            ? 'update'
            : rawMode === 'push'
              ? 'push'
              : 'replace';
        const targetId = (attrs.target ?? attrs.targetId ?? '').trim() || undefined;
        const parentId = (attrs.parent ?? attrs.parentId ?? '').trim() || undefined;
        const d: WbRenderDirective = {
          type: 'wb_render',
          id: (attrs.id ?? '').trim() || `diagram-${Date.now()}`,
          title: (attrs.title ?? '').trim() || 'Architecture Overview',
          mode,
          targetId,
          parentId,
          mermaidCode,
          nodeCodeMap,
        };
        return d;
      }
      case 'wb_focus': {
        const id = (attrs.id ?? '').trim();
        if (!id) {
          return null;
        }
        const d: WbFocusDirective = {
          type: 'wb_focus',
          id,
          edge: attrs.edge?.trim() || undefined,
        };
        return d;
      }
      case 'wb_pop': {
        const d: WbPopDirective = { type: 'wb_pop' };
        return d;
      }
      case 'wb_clear': {
        const d: WbClearDirective = { type: 'wb_clear' };
        return d;
      }
      case 'walkthrough_done': {
        const d: WalkthroughDoneDirective = { type: 'walkthrough_done' };
        return d;
      }
      case 'code_goto': {
        const file = (attrs.file ?? '').trim();
        if (!file) {
          return null;
        }
        const lines = parseLineRange(attrs.lines);
        const rawView = attrs.view?.trim().toLowerCase();
        const view: CodeViewMode | undefined =
          rawView === 'source' ||
          rawView === 'file' ||
          rawView === 'code' ||
          rawView === 'raw'
            ? 'source'
            : rawView === 'diff'
              ? 'diff'
              : undefined;
        const d: CodeGotoDirective = {
          type: 'code_goto',
          file,
          lines,
          view,
          label: attrs.label?.trim() || undefined,
        };
        return d;
      }
      case 'review_note':
      case 'action_item': {
        const file = (attrs.file ?? '').trim();
        const parsedLine = parseLineRange(attrs.line ?? attrs.lines)?.start;
        const line = parsedLine && parsedLine > 0 ? parsedLine : 0;
        const defaultSev =
          name === 'action_item' || attrs.kind?.trim().toLowerCase() === 'action'
            ? 'action'
            : 'info';
        const sevRaw = (attrs.severity ?? defaultSev).trim().toLowerCase();
        const severity: ReviewNoteDirective['severity'] =
          sevRaw === 'action' ||
          sevRaw === 'todo' ||
          sevRaw === 'followup' ||
          sevRaw === 'follow-up'
            ? 'action'
            : sevRaw === 'issue' || sevRaw === 'error' || sevRaw === 'bug'
              ? 'issue'
              : sevRaw === 'warning' || sevRaw === 'warn' || sevRaw === 'risk'
                ? 'warning'
                : defaultSev === 'action' && !attrs.severity
                  ? 'action'
                  : 'info';
        const noteBody = body.trim() || (attrs.body ?? '').trim();
        if (!noteBody) {
          return null;
        }
        const d: ReviewNoteDirective = {
          type: 'review_note',
          file,
          line,
          severity,
          body: noteBody,
        };
        return d;
      }
      case 'call_chain': {
        const { nodes, activeIndex } = parseCallChainBody(body);
        if (nodes.length === 0) {
          return null;
        }
        const d: CallChainDirective = {
          type: 'call_chain',
          title: (attrs.title ?? '').trim() || '主调用链路',
          nodes,
          activeIndex,
        };
        return d;
      }
    }
  }
}

type TagProbeResult =
  | { kind: 'not-a-tag' }
  | { kind: 'incomplete' }
  | {
      kind: 'complete';
      name: KnownTag;
      isClosing: boolean;
      selfClosing: boolean;
      attrText: string;
      endIdx: number;
    };

function inspectPotentialTag(buf: string): TagProbeResult {
  // Check whether buf (starting with '<') can match </?known_tag
  const afterLt = buf.slice(1);
  const isClosing = afterLt.startsWith('/');
  const nameStart = isClosing ? afterLt.slice(1) : afterLt;

  if (nameStart.length === 0) {
    return { kind: 'incomplete' };
  }

  // Must start with ASCII letter or underscore for our tags
  if (!/^[a-z]/i.test(nameStart)) {
    return { kind: 'not-a-tag' };
  }

  // Extract identifier prefix read so far
  const idMatch = nameStart.match(/^([a-z_]+)/i);
  const idPrefix = idMatch ? idMatch[1].toLowerCase() : '';
  const hasTerminatorAfterId = nameStart.length > idPrefix.length;

  if (!hasTerminatorAfterId) {
    const couldMatch = KNOWN_TAGS.some((t) => t.startsWith(idPrefix));
    return couldMatch ? { kind: 'incomplete' } : { kind: 'not-a-tag' };
  }

  const nextChar = nameStart[idPrefix.length];
  if (!/[\s/>]/.test(nextChar)) {
    return { kind: 'not-a-tag' };
  }

  const matchedTag = KNOWN_TAGS.find((t) => t === idPrefix);
  if (!matchedTag) {
    return { kind: 'not-a-tag' };
  }

  // Scan forward respecting quotes to find unquoted '>'
  const scanStart = 1 + (isClosing ? 1 : 0) + idPrefix.length;
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let i = scanStart; i < buf.length; i++) {
    const ch = buf[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote !== null) {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '>') {
      const inner = buf.slice(scanStart, i).trim();
      const selfClosing = inner.endsWith('/');
      const attrText = selfClosing ? inner.slice(0, -1).trim() : inner;
      return {
        kind: 'complete',
        name: matchedTag,
        isClosing,
        selfClosing,
        attrText,
        endIdx: i,
      };
    }
  }

  return { kind: 'incomplete' };
}

function parseAttributes(attrText: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (!attrText) {
    return attrs;
  }
  const regex = /([a-zA-Z_][a-zA-Z0-9_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(attrText)) !== null) {
    const key = match[1];
    const val = match[2] !== undefined ? match[2] : (match[3] ?? '');
    attrs[key] = val;
  }
  return attrs;
}

function parseLineRange(raw?: string): LineRange | undefined {
  if (!raw) {
    return undefined;
  }
  const clean = raw.trim();
  const rangeMatch = clean.match(/^(\d+)\s*[-–:]\s*(\d+)$/);
  if (rangeMatch) {
    const start = Number.parseInt(rangeMatch[1], 10);
    const end = Number.parseInt(rangeMatch[2], 10);
    if (start > 0) {
      return { start, end: Math.max(start, end) };
    }
  }
  const singleMatch = clean.match(/^(\d+)$/);
  if (singleMatch) {
    const line = Number.parseInt(singleMatch[1], 10);
    if (line > 0) {
      return { start: line, end: line };
    }
  }
  return undefined;
}

function findSentenceBoundary(text: string, forceFlush: boolean): number {
  const MIN_CHARS = 8;
  const SOFT_COMMA_THRESHOLD = 95;

  let nonSpaceCount = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!/\s/.test(ch)) {
      nonSpaceCount += 1;
    }

    // 1. CJK strong sentence terminators
    if (ch === '。' || ch === '！' || ch === '？' || ch === '；') {
      if (nonSpaceCount >= MIN_CHARS || forceFlush) {
        return i + 1;
      }
      continue;
    }

    // 2. Paragraph / explicit newlines
    if (ch === '\n') {
      if (nonSpaceCount >= MIN_CHARS || text[i + 1] === '\n') {
        return i + 1;
      }
      continue;
    }

    // 3. English ! or ? followed by whitespace
    if ((ch === '!' || ch === '?') && i + 1 < text.length && /\s/.test(text[i + 1])) {
      if (nonSpaceCount >= MIN_CHARS || forceFlush) {
        return i + 1;
      }
      continue;
    }

    // 4. English period '.' followed by whitespace, avoiding paths (auth.ts) & list numbers (1. )
    if (ch === '.' && i + 1 < text.length && /\s/.test(text[i + 1])) {
      const prev = i > 0 ? text[i - 1] : '';
      const isDigitBefore = /\d/.test(prev);
      if (!isDigitBefore && (nonSpaceCount >= MIN_CHARS || forceFlush)) {
        return i + 1;
      }
      continue;
    }

    // 5. Soft split on long clauses to keep voice streaming snappy
    if (nonSpaceCount >= SOFT_COMMA_THRESHOLD && (ch === '，' || ch === ',')) {
      return i + 1;
    }
  }

  if (forceFlush) {
    return text.length;
  }

  return -1;
}

function normalizeSpokenText(raw: string): string {
  return raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sanitizeMermaidCode(raw: string): string {
  let code = raw.trim();
  code = code.replace(/^```(?:mermaid)?\s*\r?\n?/i, '');
  code = code.replace(/\r?\n?```\s*$/i, '');
  code = code.replace(/\r\n/g, '\n').trim();

  if (!code) {
    return '';
  }

  const headerLine =
    code
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith('%%')) ?? '';
  const isFlowchart = /^(?:flowchart|graph)\b/i.test(headerLine);
  if (!isFlowchart) {
    return code;
  }

  // Convert sequenceDiagram-style `Note right/left/over NodeId: text` inside flowcharts into valid dashed note nodes
  let noteSeq = 0;
  const noteRegex =
    /^(\s*)Note\s+(?:right\s+of|left\s+of|over)\s+([A-Za-z_][A-Za-z0-9_-]*)(?:\s*,\s*[A-Za-z_][A-Za-z0-9_-]*)?\s*:\s*(.+)$/i;

  // Auto-quote unquoted rectangular node labels containing parentheses, colons, or slashes
  // Example: Auth[Token Refresh (v2)] -> Auth["Token Refresh (v2)"]
  const fixedLines = code.split('\n').map((rawLine) => {
    const noteMatch = rawLine.match(noteRegex);
    let line = rawLine;
    if (noteMatch) {
      noteSeq += 1;
      const [, indent, targetNodeId, noteBody] = noteMatch;
      const cleanBody = noteBody.trim().replace(/"/g, "'");
      line = `${indent}_Note_${noteSeq}["📝 ${cleanBody}"] -.-> ${targetNodeId}`;
    }

    const trimmed = line.trim();
    if (
      trimmed.startsWith('%%') ||
      trimmed.startsWith('subgraph') ||
      trimmed.startsWith('classDef') ||
      trimmed.startsWith('class ') ||
      trimmed.startsWith('style ') ||
      trimmed.startsWith('linkStyle')
    ) {
      return line;
    }
    return line.replace(
      /\b([A-Za-z_][A-Za-z0-9_-]*)\[([^\[\]"\n]+)\]/g,
      (full, id: string, label: string) => {
        const t = label.trim();
        // Preserve special Mermaid shapes like [(DB)], [[Sub]], [/Parallelogram/]
        if (
          /^\(.*\)$/.test(t) ||
          /^\[.*\]$/.test(t) ||
          /^\/.*\/$/.test(t) ||
          /^\\.*\\$/.test(t)
        ) {
          return full;
        }
        if (/[():;<>]/.test(t)) {
          const escaped = t.replace(/"/g, "'");
          return `${id}["${escaped}"]`;
        }
        return full;
      }
    );
  });

  return fixedLines.join('\n');
}
