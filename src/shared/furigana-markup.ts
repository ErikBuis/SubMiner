/** One run of text, with the reading written above it when it has one. */
export interface FuriganaSegment {
  text: string;
  reading?: string;
}

// Anki's own furigana syntax: the base is everything since the last space, then [reading].
const BRACKET_FURIGANA_PATTERN = / ?([^\s[\]]+?)\[([^\]]+)\]/g;

/** Splits Anki bracket furigana ("乗[の]り 遅[おく]れる") into base text and readings. */
export function parseBracketFurigana(value: string): FuriganaSegment[] {
  const segments: FuriganaSegment[] = [];
  let offset = 0;
  for (const match of value.matchAll(BRACKET_FURIGANA_PATTERN)) {
    const start = match.index ?? 0;
    if (start > offset) segments.push({ text: value.slice(offset, start) });
    segments.push({ text: match[1] ?? '', reading: match[2] });
    offset = start + match[0].length;
  }
  if (offset < value.length) segments.push({ text: value.slice(offset) });
  return segments;
}

/** The text without readings, as the sentence reads on screen. */
export function stripBracketFurigana(value: string): string {
  return parseBracketFurigana(value)
    .map((segment) => segment.text)
    .join('');
}

/**
 * The part of furigana-annotated text that spells `line`, or null when `line` does not
 * start and end on segment boundaries. Whitespace is ignored when matching, since the
 * furigana syntax uses spaces as delimiters.
 */
export function sliceFuriganaForLine(
  segments: FuriganaSegment[],
  line: string,
): FuriganaSegment[] | null {
  const target = line.replace(/\s+/g, '');
  if (!target) return null;
  const visible = segments.map((segment) => segment.text.replace(/\s+/g, ''));
  const full = visible.join('');
  let from = full.indexOf(target);
  while (from >= 0) {
    const to = from + target.length;
    let position = 0;
    let first = -1;
    let last = -1;
    for (const [index, text] of visible.entries()) {
      if (text.length > 0 && position === from) first = index;
      position += text.length;
      if (text.length > 0 && position === to) last = index;
    }
    if (first >= 0 && last >= first) return segments.slice(first, last + 1);
    from = full.indexOf(target, from + 1);
  }
  return null;
}
