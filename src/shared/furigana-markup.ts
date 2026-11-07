/** One run of text, with the reading written above it when it has one. */
export interface FuriganaSegment {
  text: string;
  reading?: string;
}

// Anki's own furigana syntax: the base is everything since the last space, then [reading].
const BRACKET_FURIGANA_PATTERN = / ?([^\s[\]]+?)\[([^\]]+)\]/g;

// Literal brackets are stored escaped (&#91; &#93;); these stand in for them while the field
// is flattened to text, so they are not read as reading delimiters.
const OPEN_BRACKET_PLACEHOLDER = '\uE000';
const CLOSE_BRACKET_PLACEHOLDER = '\uE001';

/** Keeps escaped literal brackets apart from furigana delimiters until the text is parsed. */
export function protectEscapedBrackets(html: string): string {
  return html
    .replace(/&#(?:91|x5b);/gi, OPEN_BRACKET_PLACEHOLDER)
    .replace(/&#(?:93|x5d);/gi, CLOSE_BRACKET_PLACEHOLDER);
}

function restoreBrackets(value: string): string {
  return value.replaceAll(OPEN_BRACKET_PLACEHOLDER, '[').replaceAll(CLOSE_BRACKET_PLACEHOLDER, ']');
}

/** Splits Anki bracket furigana ("乗[の]り 遅[おく]れる") into base text and readings. */
export function parseBracketFurigana(value: string): FuriganaSegment[] {
  const segments: FuriganaSegment[] = [];
  let offset = 0;
  for (const match of value.matchAll(BRACKET_FURIGANA_PATTERN)) {
    const start = match.index ?? 0;
    if (start > offset) segments.push({ text: restoreBrackets(value.slice(offset, start)) });
    segments.push({
      text: restoreBrackets(match[1] ?? ''),
      reading: restoreBrackets(match[2] ?? ''),
    });
    offset = start + match[0].length;
  }
  if (offset < value.length) segments.push({ text: restoreBrackets(value.slice(offset)) });
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
 * Whether the text after a base in the line (`shown`) can be the text after it in the
 * source (`source`). The line may end earlier, as the source joins lines, but a base that
 * runs into kana the source does not have, or loses kana the source has, is another word.
 */
function followsLikeSource(shown: string, source: string): boolean {
  const common = Math.min(shown.length, source.length);
  if (shown.slice(0, common) !== source.slice(0, common)) return false;
  const extra = shown[common] ?? source[common] ?? '';
  return !/\p{Script=Hiragana}/u.test(extra);
}

/** Up to the anchor's length of the text from `start`, stopping at whitespace. */
function untilSpace(value: string, start: number): string {
  return /^\S*/.exec(value.slice(start, start + ANCHOR_CONTEXT_LENGTH))?.[0] ?? '';
}

interface ReadingAnchor {
  /** Where the base starts in the line without whitespace. */
  found: number;
  length: number;
  reading: string;
  /** Position among the readings, for telling an unused one apart from a used one. */
  order: number;
}

/**
 * `line` with the readings of `segments` placed over it, or null when none of them fits.
 * The line keeps its own text and spacing: the furigana syntax uses spaces as delimiters,
 * and its text may differ from the line (a speaker label, another line merged in). Each
 * reading is anchored on its base plus the characters after it (up to the end of its source
 * line), and the readings are placed in order, as many as fit.
 */
export function annotateLineWithFurigana(
  segments: FuriganaSegment[],
  line: string,
): FuriganaSegment[] | null {
  // Source line breaks stay, so a reading near the end of a line is not matched against
  // the start of the next one.
  const text = segments.map((segment) => segment.text.replace(/[^\S\n]+/g, ''));
  const fullText = text.join('');
  // The line without whitespace, and where each of its characters sits in the line.
  let stripped = '';
  const lineIndexes: number[] = [];
  for (let index = 0; index < line.length; index++) {
    if (/\s/.test(line[index] ?? '')) continue;
    stripped += line[index];
    lineIndexes.push(index);
  }

  // The source with its spacing, for spotting where a space-joined source line ends.
  const spacedText = segments.map((segment) => segment.text).join('');

  // Every place each reading fits.
  const candidates: ReadingAnchor[][] = [];
  let textOffset = 0;
  let spacedOffset = 0;
  for (const [index, segment] of segments.entries()) {
    const base = text[index] ?? '';
    textOffset += base.length;
    spacedOffset += segment.text.length;
    if (!segment.reading || !base) continue;
    const following =
      fullText.slice(textOffset, textOffset + ANCHOR_CONTEXT_LENGTH).split('\n')[0] ?? '';
    // A space in the source may be where one subtitle line was joined to the next, so the
    // base may also sit where the line ends or has a space at the same point.
    const followingToSpace = untilSpace(spacedText, spacedOffset);
    const found: ReadingAnchor[] = [];
    for (let at = stripped.indexOf(base); at >= 0; at = stripped.indexOf(base, at + 1)) {
      const shown = stripped.slice(at + base.length, at + base.length + ANCHOR_CONTEXT_LENGTH);
      const shownToSpace = untilSpace(
        line,
        (lineIndexes[at + base.length - 1] ?? line.length - 1) + 1,
      );
      const endsLikeSource =
        followingToSpace.length < ANCHOR_CONTEXT_LENGTH && shownToSpace === followingToSpace;
      if (!endsLikeSource && !followsLikeSource(shown, following)) continue;
      found.push({
        found: at,
        length: base.length,
        reading: segment.reading,
        order: candidates.length,
      });
    }
    candidates.push(found);
  }

  // The most readings that can be placed in order without overlapping.
  const best = new Map<ReadingAnchor, { count: number; previous?: ReadingAnchor }>();
  let winner: ReadingAnchor | undefined;
  for (const [index, anchors] of candidates.entries()) {
    for (const anchor of anchors) {
      let previous: ReadingAnchor | undefined;
      let count = 0;
      for (const earlier of candidates.slice(0, index).flat()) {
        const score = best.get(earlier)?.count ?? 0;
        if (earlier.found + earlier.length <= anchor.found && score > count) {
          count = score;
          previous = earlier;
        }
      }
      best.set(anchor, { count: count + 1, previous });
      if (!winner || count + 1 > (best.get(winner)?.count ?? 0)) winner = anchor;
    }
  }
  if (!winner) return null;
  const placed: ReadingAnchor[] = [];
  for (
    let anchor: ReadingAnchor | undefined = winner;
    anchor;
    anchor = best.get(anchor)?.previous
  ) {
    placed.unshift(anchor);
  }

  const result: FuriganaSegment[] = [];
  let position = 0;
  for (const anchor of placed) {
    const start = lineIndexes[anchor.found] ?? 0;
    const end = (lineIndexes[anchor.found + anchor.length - 1] ?? 0) + 1;
    if (start > position) result.push({ text: line.slice(position, start) });
    result.push({ text: line.slice(start, end), reading: anchor.reading });
    position = end;
  }
  if (position < line.length) result.push({ text: line.slice(position) });
  return result;
}
