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

/** Fraction of a primary line that must fall inside a secondary event to join its sentence. */
export const DEFAULT_SENTENCE_GROUP_MIN_OVERLAP = 0.6;
/** Fraction of a primary line that must fall inside the mined range to count as mined. */
const CO_TIMED_EPSILON_SECONDS = 0.01;
const SCORE_EPSILON = 1e-9;
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
  const best: Array<{ score: number; fit: number; secondary: TimedSubtitleText } | undefined> = [];

  let first = 0;
  for (const event of secondary) {
    while (first < primary.length && primary[first]!.endTime <= event.startTime) {
      first += 1;
    }

    const candidates: number[] = [];
    for (
      let index = first;
      index < primary.length && primary[index]!.startTime < event.endTime;
      index += 1
    ) {
      const line = primary[index]!;
      if (overlapSeconds(line, event) / duration(line) >= minOverlapRatio) {
        candidates.push(index);
      }
    }
    // Lines of a split sentence follow each other. Of lines nested in one another (a
    // dialogue line under a long sign) the event only claims the one it is timed to.
    const lineFit = (index: number) => {
      const line = primary[index]!;
      return (
        overlapSeconds(line, event) /
        Math.max(duration(event), duration(line), MIN_DURATION_SECONDS)
      );
    };
    const nested = (a: number, b: number) =>
      overlapSeconds(primary[a]!, primary[b]!) >= 0.5 * duration(primary[a]!);
    const members = candidates.filter(
      (member) =>
        !candidates.some(
          (other) =>
            other !== member &&
            (nested(member, other) || nested(other, member)) &&
            lineFit(other) > lineFit(member),
        ),
    );
    if (members.length === 0) continue;

    const spanStart = primary[members[0]!]!.startTime;
    const spanEnd = latestEnd(members.map((member) => primary[member]!));
    const score =
      overlapSeconds({ startTime: spanStart, endTime: spanEnd }, event) /
      Math.max(duration(event), spanEnd - spanStart, MIN_DURATION_SECONDS);
    for (const member of members) {
      const line = primary[member]!;
      // On a tie, the event timed closest to the line itself wins, so a dialogue line
      // under a long sign takes its own translation rather than the sign's.
      const fit =
        overlapSeconds(line, event) /
        Math.max(duration(event), duration(line), MIN_DURATION_SECONDS);
      const current = best[member];
      if (
        !current ||
        current.score < score - SCORE_EPSILON ||
        (Math.abs(current.score - score) <= SCORE_EPSILON && current.fit < fit)
      ) {
        best[member] = { score, fit, secondary: event };
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

function coTimed(
  a: Pick<TimedSubtitleText, 'startTime' | 'endTime'>,
  b: Pick<TimedSubtitleText, 'startTime' | 'endTime'>,
): boolean {
  return (
    Math.abs(a.startTime - b.startTime) < CO_TIMED_EPSILON_SECONDS &&
    Math.abs(a.endTime - b.endTime) < CO_TIMED_EPSILON_SECONDS
  );
}

const DIALOGUE_DASH = /^[-－―‐–—]/u;

function cueLines(text: string): string[] {
  return text
    .split(/\r?\n|\\N/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** A cue led by a dialogue dash: one speaker of several sharing the screen. */
function isDialogue(text: string): boolean {
  return DIALOGUE_DASH.test(text.trim());
}

/** Speakers in one cue: its dash-led lines (a speaker's text can wrap), or 1. */
function speakerCount(text: string): number {
  const lines = cueLines(text);
  const starts = lines.filter(isDialogue).length;
  return lines.length > 0 && isDialogue(lines[0]!) && starts > 1 ? starts : 1;
}

/**
 * The secondary lines each primary line of an already grouped track translates to, by
 * primary index. A line no secondary event claimed takes the secondary event it overlaps
 * most. Consecutive lines of a sentence share their translation. The whole track is
 * resolved at once so speakers sharing one interval each get their own translation,
 * whichever of them is mined.
 */
export function assignGroupTranslations(
  primary: readonly TimedSubtitleText[],
  secondary: readonly TimedSubtitleText[],
  groups: readonly SentenceTranslationGroup[],
): Map<number, TimedSubtitleText[]> {
  const assigned = new Map<number, TimedSubtitleText[]>();
  const takenBy = new Map<TimedSubtitleText, TimedSubtitleText>();
  primary.forEach((line, index) => {
    const grouped = groups[index]?.secondary ?? findBestOverlappingLine(secondary, line);
    if (!grouped) return;
    const coTimedCues = secondary.filter((cue) => coTimed(cue, grouped));
    const owner = takenBy.get(grouped);
    let lines: TimedSubtitleText[];
    if (owner && !coTimed(line, owner)) {
      // Consecutive lines of one sentence share its translation.
      lines = [grouped];
    } else if (isDialogue(line.text)) {
      // Dialogue takes dialogue cues, so a sign sharing the interval stays out. A cue
      // holding several speakers is shared; any other goes to one speaker. A cue with
      // several speakers takes as many cues as it needs, the grouped one first.
      const available = coTimedCues
        .filter((cue) => isDialogue(cue.text))
        .filter((cue) => !takenBy.has(cue) || speakerCount(cue.text) > 1)
        .sort((a, b) => Number(b === grouped) - Number(a === grouped));
      const speakers = speakerCount(line.text);
      lines = [];
      let covered = 0;
      for (const cue of available) {
        if (covered >= speakers) break;
        lines.push(cue);
        covered += speakerCount(cue.text);
      }
      if (lines.length === 0) lines = [grouped];
    } else {
      // A line co-timed with the one that took this translation is another speaker and
      // gets the co-timed secondary cue, unless it repeats that line's text.
      const ownText = compactText(line.text);
      const repeats =
        owner !== undefined &&
        (compactText(owner.text).includes(ownText) || ownText.includes(compactText(owner.text)));
      const partner = owner && !repeats ? coTimedCues.find((cue) => !takenBy.has(cue)) : undefined;
      lines = [partner ?? grouped];
    }
    for (const cue of lines) {
      if (!takenBy.has(cue)) takenBy.set(cue, line);
    }
    assigned.set(index, lines);
  });
  return assigned;
}

/** Secondary lines translating the primary lines at `indexes` of an already grouped track. */
export function collectGroupTranslationLines(
  primary: readonly TimedSubtitleText[],
  secondary: readonly TimedSubtitleText[],
  groups: readonly SentenceTranslationGroup[],
  indexes: readonly number[],
): TimedSubtitleText[] {
  const assigned = assignGroupTranslations(primary, secondary, groups);
  const lines = new Set<TimedSubtitleText>();
  for (const index of indexes) {
    for (const translation of assigned.get(index) ?? []) lines.add(translation);
  }
  return [...lines].sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);
}

function compactText(text: string): string {
  return text.normalize('NFKC').replace(/\s+/gu, '');
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
  /**
   * The card sentence. Mined lines whose text it lacks (a short sign inside the dialogue,
   * a line skipped by a seek) are left out, unless that would leave none.
   */
  sentenceText?: string;
  widenSentence?: boolean;
  /** Widening stops at this many seconds; 0 or less disables the cap. */
  maxSentenceSeconds?: number;
  minOverlapRatio?: number;
}): AlignedSentenceTranslation | null {
  const primary = sortSubtitleLines(options.primaryLines);
  const secondary = sortSubtitleLines(options.secondaryLines);
  const minedRange = { startTime: options.startTime, endTime: options.endTime };
  if (primary.length === 0 || !(minedRange.endTime > minedRange.startTime)) return null;

  let minedIndexes: number[] = [];
  primary.forEach((line, index) => {
    if (overlapSeconds(line, minedRange) / duration(line) >= MINED_LINE_MIN_OVERLAP) {
      minedIndexes.push(index);
    }
  });
  if (minedIndexes.length === 0) return null;
  const sentence = compactText(options.sentenceText ?? '');
  if (sentence) {
    const inSentence = minedIndexes.filter((index) =>
      sentence.includes(compactText(primary[index]!.text)),
    );
    if (inSentence.length > 0) minedIndexes = inSentence;
  }

  const groups = buildSentenceTranslationGroups(
    primary,
    secondary,
    options.minOverlapRatio ?? DEFAULT_SENTENCE_GROUP_MIN_OVERLAP,
  );
  // Only the mined lines: a long sign between two dialogue lines starts in between but
  // is not part of the sentence.
  let indexes = minedIndexes;
  if (options.widenSentence) {
    // Every primary line the matching secondary events translate, also across a sign
    // with its own translation that splits them into separate runs.
    const targets = new Set(
      [groups[minedIndexes[0]!], groups[minedIndexes[minedIndexes.length - 1]!]]
        .map((group) => group?.secondary)
        .filter((event): event is TimedSubtitleText => Boolean(event)),
    );
    const widened = new Set(minedIndexes);
    groups.forEach((group, index) => {
      if (group.secondary && targets.has(group.secondary)) widened.add(index);
    });
    const candidate = [...widened].sort((a, b) => a - b);
    const candidateLines = candidate.map((index) => primary[index]!);
    const span = latestEnd(candidateLines) - candidateLines[0]!.startTime;
    const maxSeconds = options.maxSentenceSeconds ?? 0;
    if (maxSeconds <= 0 || span <= maxSeconds) indexes = candidate;
  }

  const lines = indexes.map((index) => primary[index]!);
  const translationLines = collectGroupTranslationLines(primary, secondary, groups, indexes);
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
/** Skips leading tags and opening quotes or brackets, but not a continuation's "...". */
function capitalizeFirstLetter(text: string): string {
  return text.replace(
    /^((?:\s|<[^>]*>|["'“‘«(\[¿¡])*)(\p{Ll})/u,
    (_match, prefix: string, letter: string) => prefix + letter.toUpperCase(),
  );
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
