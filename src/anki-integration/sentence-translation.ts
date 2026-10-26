import {
  alignSentenceTranslation,
  assignLineTranslations,
  findBestOverlappingLine,
  joinSubtitleLineTexts,
  REVIEW_CONTEXT_EPSILON_SECONDS,
  REVIEW_CONTEXT_LINE_LIMIT,
  sortSubtitleLines,
  type TimedSubtitleText,
} from '../shared/sentence-translation-alignment';

/** Parsed primary and secondary subtitle tracks, in the same timeline as the mined range. */
export interface SubtitleTracksForTranslation {
  primary: readonly TimedSubtitleText[];
  secondary: readonly TimedSubtitleText[];
}

export interface TimedSentenceTranslation {
  translation: string;
  /** The parsed secondary lines `translation` was built from. */
  translationLines: TimedSubtitleText[];
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
function isSourceLanguageText(translationLines: readonly string[], minedText: string): boolean {
  const compact = (text: string) => text.normalize('NFKC').replace(/\s+/gu, '');
  const lines = translationLines
    .flatMap((text) => text.split(/\r?\n|\\N/))
    .map(compact)
    .filter(Boolean);
  const candidate = lines.join('');
  const mined = compact(minedText);
  if (!mined) return false;
  if (mined.includes(candidate)) return true;
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
 * Picks the secondary subtitle line(s) that translate a mined range by their timing. The
 * secondary text on screen when mining can include unrelated overlapping lines (a TV in
 * the background, a sign) and can belong to the next sentence already, so the parsed
 * tracks are paired up instead. Null when the tracks are not parsed or nothing matches.
 */
export function resolveTimedSentenceTranslation(input: {
  text: string;
  startTime: number;
  endTime: number;
  tracks: SubtitleTracksForTranslation | null;
}): TimedSentenceTranslation | null {
  const secondary = sortSubtitleLines(input.tracks?.secondary ?? []);
  if (secondary.length === 0) return null;
  const aligned = alignSentenceTranslation({
    primaryLines: input.tracks?.primary ?? [],
    secondaryLines: secondary,
    startTime: input.startTime,
    endTime: input.endTime,
    sentenceText: input.text,
  });
  const best = aligned ? null : findBestOverlappingLine(secondary, input);
  const translationLines = aligned?.translationLines ?? (best ? [best] : []);
  const translation = joinSubtitleLineTexts(translationLines);
  if (
    !translation ||
    isSourceLanguageText(
      translationLines.map((line) => line.text),
      input.text,
    )
  ) {
    return null;
  }
  return {
    translation,
    translationLines: translationLines.map(toPlainLine),
  };
}

/**
 * Translators often give one secondary line to a sentence the primary track splits over
 * several lines. Widens the mined range to every primary line that secondary line covers,
 * as long as the result stays within `maxSentenceSeconds` (0: no cap). Null when there is
 * nothing to widen.
 */
export function widenSentenceToTranslation(input: {
  /** The captured sentence; mined lines it lacks (a sign) are not widened from. */
  text?: string;
  startTime: number;
  endTime: number;
  tracks: SubtitleTracksForTranslation | null;
  maxSentenceSeconds: number;
}): { text: string; startTime: number; endTime: number } | null {
  const aligned = alignSentenceTranslation({
    primaryLines: input.tracks?.primary ?? [],
    secondaryLines: input.tracks?.secondary ?? [],
    startTime: input.startTime,
    endTime: input.endTime,
    sentenceText: input.text,
    widenSentence: true,
    maxSentenceSeconds: input.maxSentenceSeconds,
  });
  if (
    !aligned ||
    (aligned.startTime >= input.startTime - 0.001 && aligned.endTime <= input.endTime + 0.001)
  ) {
    return null;
  }
  const startTime = Math.min(aligned.startTime, input.startTime);
  const endTime = Math.max(aligned.endTime, input.endTime);
  if (input.maxSentenceSeconds > 0 && endTime - startTime > input.maxSentenceSeconds + 0.001) {
    return null;
  }
  return { text: aligned.text, startTime, endTime };
}

/** Secondary lines this close to the clip always reach the review. */
const REVIEW_LINE_WINDOW_SECONDS = 90;

function toPlainLine({ text, startTime, endTime }: TimedSubtitleText): TimedSubtitleText {
  return { text, startTime, endTime };
}

/**
 * What the media timing review needs to keep the translation in step when lines are
 * added: the secondary lines around the clip, and for every primary line it can offer
 * (up to the review's line limit on each side) the secondary lines the sentence grouping
 * of the whole track assigns it.
 */
export function buildReviewTranslationContext(input: {
  startTime: number;
  endTime: number;
  tracks: SubtitleTracksForTranslation | null;
}): {
  lines: TimedSubtitleText[];
  lineTranslations: Array<{ startTime: number; endTime: number; lines: TimedSubtitleText[] }>;
} {
  const primary = sortSubtitleLines(input.tracks?.primary ?? []);
  const secondary = sortSubtitleLines(input.tracks?.secondary ?? []);
  if (secondary.length === 0) return { lines: [], lineTranslations: [] };
  const offeredBefore = primary
    .filter((line) => line.endTime <= input.startTime + REVIEW_CONTEXT_EPSILON_SECONDS)
    .slice(-REVIEW_CONTEXT_LINE_LIMIT);
  const offeredAfter = primary
    .filter((line) => line.startTime >= input.endTime - REVIEW_CONTEXT_EPSILON_SECONDS)
    .slice(0, REVIEW_CONTEXT_LINE_LIMIT);
  const windowStart = Math.min(
    input.startTime - REVIEW_LINE_WINDOW_SECONDS,
    offeredBefore[0]?.startTime ?? Infinity,
  );
  const windowEnd = Math.max(
    input.endTime + REVIEW_LINE_WINDOW_SECONDS,
    ...offeredAfter.map((line) => line.endTime),
  );
  const nearClip = (line: TimedSubtitleText): boolean =>
    line.endTime >= windowStart && line.startTime <= windowEnd;
  return {
    lines: secondary.filter(nearClip).map(toPlainLine),
    lineTranslations: assignLineTranslations(primary, secondary)
      .filter(({ line }) => nearClip(line))
      .map(({ line, translationLines }) => ({
        startTime: line.startTime,
        endTime: line.endTime,
        lines: translationLines.map(toPlainLine),
      })),
  };
}

/** Plain-text rendering of an Anki field for display: one line per block or list item. */
export function ankiFieldHtmlToPlainText(html: string): string {
  return html
    .replace(/\[sound:[^\]]+\]/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:li|div|p|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/** A plain-text value (typed in the review) written into an Anki HTML field. */
export function plainTextToAnkiFieldHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
