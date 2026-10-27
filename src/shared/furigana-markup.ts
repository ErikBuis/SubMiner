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

/** How many characters after a reading's base must match for the base to be anchored. */
const ANCHOR_CONTEXT_LENGTH = 2;

/**
 * `line` with the readings of `segments` placed over it, or null when none of them fits.
 * The line keeps its own text and spacing: the furigana syntax uses spaces as delimiters,
 * and its text may differ from the line (a speaker label, another line merged in), so each
 * reading is anchored on its base plus the characters after it, in order.
 */
export function annotateLineWithFurigana(
  segments: FuriganaSegment[],
  line: string,
): FuriganaSegment[] | null {
  const text = segments.map((segment) => segment.text.replace(/\s+/g, ''));
  const fullText = text.join('');
  // The line without whitespace, and where each of its characters sits in the line.
  let stripped = '';
  const lineIndexes: number[] = [];
  for (let index = 0; index < line.length; index++) {
    if (/\s/.test(line[index] ?? '')) continue;
    stripped += line[index];
    lineIndexes.push(index);
  }
  const anchors: Array<{ start: number; end: number; reading: string }> = [];
  let textOffset = 0;
  let cursor = 0;
  for (const [index, segment] of segments.entries()) {
    const base = text[index] ?? '';
    textOffset += base.length;
    if (!segment.reading || !base) continue;
    const following = fullText.slice(textOffset, textOffset + ANCHOR_CONTEXT_LENGTH);
    const found = stripped.indexOf(base + following, cursor);
    if (found < 0) continue;
    cursor = found + base.length;
    anchors.push({
      start: lineIndexes[found] ?? 0,
      end: (lineIndexes[found + base.length - 1] ?? 0) + 1,
      reading: segment.reading,
    });
  }
  if (anchors.length === 0) return null;
  const result: FuriganaSegment[] = [];
  let position = 0;
  for (const anchor of anchors) {
    if (anchor.start > position) result.push({ text: line.slice(position, anchor.start) });
    result.push({ text: line.slice(anchor.start, anchor.end), reading: anchor.reading });
    position = anchor.end;
  }
  if (position < line.length) result.push({ text: line.slice(position) });
  return result;
}
