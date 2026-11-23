/**
 * Normalizes technical text for natural TTS pronunciation while leaving
 * visual subtitles and interruption transcripts untouched.
 */
export function normalizeTextForTts(raw: string): string {
  if (!raw) {
    return '';
  }

  let text = raw
    // Strip markdown inline code, bold, strikethrough
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1');

  // Arrows and namespace colons
  text = text
    .replace(/\s*(?:->|=>|→)\s*/g, ' 到 ')
    .replace(/::/g, ' ');

  // Slashes adjacent to ASCII words/paths (preserve numeric fractions like 2/5)
  text = text.replace(/([A-Za-z0-9._-])\/([A-Za-z._-])/g, '$1 $2');
  text = text.replace(/([A-Za-z._-])\/([A-Za-z0-9._-])/g, '$1 $2');
  text = text.replace(/(^|\s)\/([A-Za-z])/g, '$1$2');

  // Leading/trailing underscores and snake_case identifiers -> spaces
  text = text.replace(/_/g, ' ');

  // Kebab-case hyphens between ASCII letters/words (preserve numeric ranges like 10-25)
  text = text.replace(/([A-Za-z])\-([A-Za-z0-9])/g, '$1 $2');
  text = text.replace(/([A-Za-z0-9])\-([A-Za-z])/g, '$1 $2');

  return text.replace(/\s+/g, ' ').trim();
}
