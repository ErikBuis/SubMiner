/**
 * Pairs primary (Japanese) subtitle lines with the secondary (translation) subtitle that
 * covers them, so a mined card gets the whole sentence and only its own translation.
 *
 * Translators routinely map one secondary event onto a sentence the primary track splits
 * over several lines, and releases overlap unrelated secondary events (a TV in the
 * background, a sign) with the dialogue. Reading the secondary text that is on screen at
 * one moment therefore both cuts sentences short and pulls in unrelated lines.
 */

import { decodeCharacterReferences, stripSubtitleTags } from './subtitle-markup';

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

/** A line that only describes a sound, such as （ドアが開く音）. */
function isSoundCue(text: string): boolean {
  const plain = text.replace(/\{[^}]*\}|<[^>]*>/g, '').replace(/\s+/gu, '');
  return /^[（(][^（）()]*[）)]$/u.test(plain);
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
    // A sound cue such as （テレビ番組の音声） is no dialogue. Claimed next to dialogue it
    // stretches the event's span, so a background line could win a dialogue line from the
    // translation of its sentence. It is claimed only when the event covers nothing else.
    const dialogue = candidates.filter((index) => !isSoundCue(primary[index]!.text));
    const claimed = dialogue.length > 0 ? dialogue : candidates;
    const members = claimed.filter(
      (member) =>
        !claimed.some(
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

/** Writing systems, with the Japanese scripts as one. */
const SCRIPT_FAMILIES: Array<[string, RegExp]> = [
  ['cjk', /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu],
  ['hangul', /\p{Script=Hangul}/gu],
  ['cyrillic', /\p{Script=Cyrillic}/gu],
  ['greek', /\p{Script=Greek}/gu],
  ['thai', /\p{Script=Thai}/gu],
  ['arabic', /\p{Script=Arabic}/gu],
  ['latin', /\p{Script=Latin}/gu],
];

/**
 * The writing system a text is mostly in. Latin only wins without any other script, since
 * Latin letters in other languages are loanwords and acronyms ("DNAって何？").
 */
function mainScriptFamily(text: string): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [family, pattern] of SCRIPT_FAMILIES) {
    const count = text.match(pattern)?.length ?? 0;
    if (family === 'latin' ? best === null && count > 0 : count > bestCount) {
      best = family;
      bestCount = count;
    }
  }
  // Letters of a script not listed here (Hebrew, Devanagari, ...) are still a language.
  if (best === null && /\p{L}/u.test(text)) return 'other';
  return best;
}

/**
 * A secondary track in the primary language is no translation: its cue is part of the
 * mined text (cut differently), or holds the mined text plus more of the same language.
 * A bilingual cue that adds a line in another script still translates, also when only
 * part of its source line was mined. Scripts stand in for languages, so a cue pairing two
 * languages of one script (Japanese and Chinese) cannot be told apart from one language.
 */
export function isSourceLanguageText(
  translationLines: readonly string[],
  minedText: string,
): boolean {
  // Cue markup (`<i>`, `&amp;`) differs between tracks and is not language.
  const comparable = (text: string) =>
    compactText(decodeCharacterReferences(stripSubtitleTags(text)));
  const lines = translationLines
    .flatMap((text) => text.split(/\r?\n|\\N/))
    .map(comparable)
    .filter(Boolean);
  const candidate = lines.join('');
  const mined = comparable(minedText);
  if (!mined) return false;
  // Cues each part of the mined text, also when their pieces are not adjacent there.
  if (lines.every((line) => mined.includes(line))) return true;
  if (!candidate.includes(mined)) return false;
  const minedFamily = mainScriptFamily(mined);
  // Whole lines are compared: what is left of a line after cutting the mined text out can
  // look foreign ("DNA" of "DNAって何？") while the line is not.
  return !lines.some((line) => {
    if (mined.includes(line)) return false;
    const family = mainScriptFamily(line);
    return family !== null && family !== minedFamily;
  });
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
  const assigned = assignGroupTranslations(primary, secondary, groups);
  return primary.map((line, index) => ({ line, translationLines: assigned.get(index) ?? [] }));
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
const TRAILING_COMMAS = [',', '、', '，'];
const CONTINUATION_MARK = '(...)';

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
 * stands alone, so it gets a "(...)" to show the sentence goes on: "Lost in that thought,
 * (...)". Closing quotes, brackets and HTML tags after the comma stay before the mark.
 */
function markContinuation(text: string): string {
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
  const comma = TRAILING_COMMAS.find((candidate) => body.endsWith(candidate));
  if (!comma) return text;
  // Full-width commas sit flush against the mark, like other CJK punctuation.
  const separator = comma === ',' ? ' ' : '';
  return text.trimEnd() + separator + CONTINUATION_MARK;
}

/**
 * How a translation reads on a card: one line, starting with a capital letter and not
 * ending in a comma. Only the card's copy changes, never the subtitle track.
 */
export function formatCardTranslation(text: string): string {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  if (!singleLine) return '';
  return markContinuation(capitalizeFirstLetter(singleLine));
}
