/**
 * Pairs primary (Japanese) subtitle lines with the secondary (translation) subtitle that
 * covers them, so a mined card gets the whole sentence and only its own translation.
 *
 * Translators routinely map one secondary event onto a sentence the primary track splits
 * over several lines, and releases overlap unrelated secondary events (a TV in the
 * background, a sign) with the dialogue. Reading the secondary text that is on screen at
 * one moment therefore both cuts sentences short and pulls in unrelated lines.
 */

export interface TimedSubtitleText {
  text: string;
  startTime: number;
  endTime: number;
}

export interface SentenceTranslationGroup {
  /** Inclusive index range into the sorted primary lines. */
  from: number;
  to: number;
  secondary: TimedSubtitleText | null;
}

export interface AlignedSentenceTranslation {
  /** Primary lines that make up the sentence, chronological. */
  lines: TimedSubtitleText[];
  text: string;
  startTime: number;
  endTime: number;
  /** Secondary lines that translate the sentence, chronological. */
  translationLines: TimedSubtitleText[];
  translation: string;
}

/** Primary lines the media timing review offers on each side of the clip. */
export const REVIEW_CONTEXT_LINE_LIMIT = 12;
/** Tolerance when deciding whether a primary line lies before or after the clip. */
export const REVIEW_CONTEXT_EPSILON_SECONDS = 0.05;

/** Fraction of a primary line that must fall inside a secondary event to join its sentence. */
export const DEFAULT_SENTENCE_GROUP_MIN_OVERLAP = 0.6;
/** Fraction of a primary line that must fall inside the mined range to count as mined. */
const MINED_LINE_MIN_OVERLAP = 0.5;
const MIN_DURATION_SECONDS = 0.001;

function isUsableLine(line: TimedSubtitleText): boolean {
  return (
    typeof line.text === 'string' &&
    line.text.trim().length > 0 &&
    Number.isFinite(line.startTime) &&
    Number.isFinite(line.endTime) &&
    line.endTime > line.startTime
  );
}

export function sortSubtitleLines<T extends TimedSubtitleText>(lines: readonly T[]): T[] {
  return lines
    .filter(isUsableLine)
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);
}

function overlapSeconds(
  a: Pick<TimedSubtitleText, 'startTime' | 'endTime'>,
  b: Pick<TimedSubtitleText, 'startTime' | 'endTime'>,
): number {
  return Math.min(a.endTime, b.endTime) - Math.max(a.startTime, b.startTime);
}

function duration(line: Pick<TimedSubtitleText, 'startTime' | 'endTime'>): number {
  return Math.max(MIN_DURATION_SECONDS, line.endTime - line.startTime);
}

/** Lines are sorted by start time, so the last one need not end latest. */
function latestEnd(lines: readonly TimedSubtitleText[]): number {
  return Math.max(...lines.map((line) => line.endTime));
}

/**
 * Partitions the sorted primary lines into sentences. Matching each primary line to its
 * best-overlapping secondary event on its own is unstable when secondary events overlap,
 * so every secondary event proposes the run of primary lines it covers, each proposal is
 * scored on how well the two spans line up, and every primary line takes the best proposal
 * it appears in. Consecutive lines with the same winner form one group.
 *
 * Returns one entry per primary line; lines in the same sentence share the same object.
 */
export function buildSentenceTranslationGroups(
  primary: readonly TimedSubtitleText[],
  secondary: readonly TimedSubtitleText[],
  minOverlapRatio = DEFAULT_SENTENCE_GROUP_MIN_OVERLAP,
): SentenceTranslationGroup[] {
  const best: Array<{ score: number; secondary: TimedSubtitleText } | undefined> = [];

  let first = 0;
  for (const event of secondary) {
    while (first < primary.length && primary[first]!.endTime <= event.startTime) {
      first += 1;
    }

    const members: number[] = [];
    for (
      let index = first;
      index < primary.length && primary[index]!.startTime < event.endTime;
      index += 1
    ) {
      const line = primary[index]!;
      if (overlapSeconds(line, event) / duration(line) >= minOverlapRatio) {
        members.push(index);
      }
    }
    if (members.length === 0) continue;

    const spanStart = primary[members[0]!]!.startTime;
    const spanEnd = latestEnd(members.map((member) => primary[member]!));
    const score =
      overlapSeconds({ startTime: spanStart, endTime: spanEnd }, event) /
      Math.max(duration(event), spanEnd - spanStart, MIN_DURATION_SECONDS);
    for (const member of members) {
      const current = best[member];
      if (!current || current.score < score) {
        best[member] = { score, secondary: event };
      }
    }
  }

  const groups: SentenceTranslationGroup[] = [];
  let index = 0;
  while (index < primary.length) {
    const match = best[index];
    let last = index;
    while (match && last + 1 < primary.length && best[last + 1]?.secondary === match.secondary) {
      last += 1;
    }
    const group: SentenceTranslationGroup = {
      from: index,
      to: last,
      secondary: match?.secondary ?? null,
    };
    for (let member = index; member <= last; member += 1) {
      groups[member] = group;
    }
    index = last + 1;
  }
  return groups;
}

/** The secondary event that overlaps the line the longest, if any overlaps at all. */
export function findBestOverlappingLine(
  lines: readonly TimedSubtitleText[],
  range: Pick<TimedSubtitleText, 'startTime' | 'endTime'>,
): TimedSubtitleText | null {
  let best: TimedSubtitleText | null = null;
  let bestOverlap = 0;
  for (const line of lines) {
    const overlap = overlapSeconds(line, range);
    if (overlap > bestOverlap) {
      best = line;
      bestOverlap = overlap;
    }
  }
  return best;
}

/** Without alignment, a line counts when this much of it (or of the range) overlaps. */
const OVERLAP_SHARE = 0.5;

/**
 * Every line that substantially overlaps the range, in order: what is on screen during
 * it. Used when sentence alignment is off.
 */
export function collectOverlappingLines(
  lines: readonly TimedSubtitleText[],
  range: Pick<TimedSubtitleText, 'startTime' | 'endTime'>,
): TimedSubtitleText[] {
  const rangeDuration = range.endTime - range.startTime;
  return sortSubtitleLines(lines).filter((line) => {
    const overlap = overlapSeconds(line, range);
    if (overlap <= 0) return false;
    return (
      overlap >= (line.endTime - line.startTime) * OVERLAP_SHARE ||
      (rangeDuration > 0 && overlap >= rangeDuration * OVERLAP_SHARE)
    );
  });
}

/**
 * Joins cue texts into one line. Simultaneous cues often repeat a line (the subtitle
 * renderer shows it once), so a line already taken from a cue overlapping in time is
 * skipped; the same line at another time is kept.
 */
export function joinSubtitleLineTexts(lines: readonly TimedSubtitleText[]): string {
  const taken: TimedSubtitleText[] = [];
  for (const cue of lines) {
    for (const rawLine of cue.text.split(/\r?\n|\\N/)) {
      const text = rawLine.replace(/\s+/g, ' ').trim();
      if (!text) continue;
      if (taken.some((line) => line.text === text && overlapSeconds(line, cue) > 0)) continue;
      taken.push({ text, startTime: cue.startTime, endTime: cue.endTime });
    }
  }
  return taken.map((line) => line.text).join(' ');
}

/**
 * Secondary lines translating the primary lines `from..to` of an already grouped track.
 * A line no secondary event claimed still takes the secondary event it overlaps most.
 */
export function collectGroupTranslationLines(
  primary: readonly TimedSubtitleText[],
  secondary: readonly TimedSubtitleText[],
  groups: readonly SentenceTranslationGroup[],
  from: number,
  to: number,
): TimedSubtitleText[] {
  const result: TimedSubtitleText[] = [];
  for (let index = from; index <= to; index += 1) {
    const line = primary[index];
    if (!line) continue;
    const translation = groups[index]?.secondary ?? findBestOverlappingLine(secondary, line);
    if (translation && !result.includes(translation)) {
      result.push(translation);
    }
  }
  return result.sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);
}

/**
 * The secondary lines each primary line translates to when the whole track is grouped,
 * so a review that adds neighbouring lines picks the same translations main would.
 */
export function assignLineTranslations(
  primaryLines: readonly TimedSubtitleText[],
  secondaryLines: readonly TimedSubtitleText[],
  minOverlapRatio = DEFAULT_SENTENCE_GROUP_MIN_OVERLAP,
): Array<{ line: TimedSubtitleText; translationLines: TimedSubtitleText[] }> {
  const primary = sortSubtitleLines(primaryLines);
  const secondary = sortSubtitleLines(secondaryLines);
  const groups = buildSentenceTranslationGroups(primary, secondary, minOverlapRatio);
  return primary.map((line, index) => ({
    line,
    translationLines: collectGroupTranslationLines(primary, secondary, groups, index, index),
  }));
}

/**
 * Resolves the sentence around a mined subtitle range and the secondary line(s) that
 * translate it. With `widenSentence` the sentence grows to every primary line the matching
 * secondary event covers; without it only the mined lines are kept and only their
 * translation is returned. Returns null when the mined range matches no primary line.
 */
export function alignSentenceTranslation(options: {
  primaryLines: readonly TimedSubtitleText[];
  secondaryLines: readonly TimedSubtitleText[];
  startTime: number;
  endTime: number;
  widenSentence?: boolean;
  /** Widening stops at this many seconds; 0 or less disables the cap. */
  maxSentenceSeconds?: number;
  minOverlapRatio?: number;
}): AlignedSentenceTranslation | null {
  const primary = sortSubtitleLines(options.primaryLines);
  const secondary = sortSubtitleLines(options.secondaryLines);
  const minedRange = { startTime: options.startTime, endTime: options.endTime };
  if (primary.length === 0 || !(minedRange.endTime > minedRange.startTime)) return null;

  const minedIndexes: number[] = [];
  primary.forEach((line, index) => {
    if (overlapSeconds(line, minedRange) / duration(line) >= MINED_LINE_MIN_OVERLAP) {
      minedIndexes.push(index);
    }
  });
  if (minedIndexes.length === 0) return null;

  const groups = buildSentenceTranslationGroups(
    primary,
    secondary,
    options.minOverlapRatio ?? DEFAULT_SENTENCE_GROUP_MIN_OVERLAP,
  );
  let from = minedIndexes[0]!;
  let to = minedIndexes[minedIndexes.length - 1]!;
  if (options.widenSentence) {
    const widenedFrom = Math.min(from, groups[from]?.from ?? from);
    const widenedTo = Math.max(to, groups[to]?.to ?? to);
    const span =
      latestEnd(primary.slice(widenedFrom, widenedTo + 1)) - primary[widenedFrom]!.startTime;
    const maxSeconds = options.maxSentenceSeconds ?? 0;
    if (maxSeconds <= 0 || span <= maxSeconds) {
      from = widenedFrom;
      to = widenedTo;
    }
  }

  const lines = primary.slice(from, to + 1);
  const translationLines = collectGroupTranslationLines(primary, secondary, groups, from, to);
  return {
    lines,
    text: joinSubtitleLineTexts(lines),
    startTime: lines[0]!.startTime,
    endTime: latestEnd(lines),
    translationLines,
    translation: joinSubtitleLineTexts(translationLines),
  };
}

const TRAILING_CLOSERS = ['"', "'", ')', ']', '”', '’', '）', '」', '』'];
const TRAILING_COMMAS: Array<[string, string]> = [
  [',', '.'],
  ['、', '。'],
  ['，', '。'],
];

/** Subtitle lines often start lowercase because they continue the previous line. */
function capitalizeFirstLetter(text: string): string {
  return text.replace(/^(\s*)(\p{Ll})/u, (_match, space: string, letter: string) => {
    return space + letter.toUpperCase();
  });
}

/**
 * A line cut off mid-sentence ends in a comma ("Lost in that thought,"). On a card it
 * stands alone, so the trailing comma becomes a full stop. Closing quotes, brackets and
 * HTML tags after the comma stay where they are.
 */
function closeSentence(text: string): string {
  let body = text;
  let tail = '';
  for (;;) {
    const piece =
      body.match(/\s+$/)?.[0] ??
      body.match(/<\/?[A-Za-z][^<>]*>$/)?.[0] ??
      TRAILING_CLOSERS.find((closer) => body.endsWith(closer));
    if (!piece) break;
    tail = piece + tail;
    body = body.slice(0, body.length - piece.length);
  }
  for (const [comma, stop] of TRAILING_COMMAS) {
    if (body.endsWith(comma)) {
      return body.slice(0, body.length - comma.length) + stop + tail;
    }
  }
  return text;
}

/**
 * How a translation reads on a card: one line, starting with a capital letter and not
 * ending in a comma. Only the card's copy changes, never the subtitle track.
 */
export function formatCardTranslation(text: string): string {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  if (!singleLine) return '';
  return closeSentence(capitalizeFirstLetter(singleLine));
}
