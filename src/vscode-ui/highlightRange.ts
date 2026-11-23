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
