import {
  alignSentenceTranslation,
  findBestOverlappingLine,
  joinSubtitleLineTexts,
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
  return best;
}

/**
 * A secondary track in the primary language is no translation: its cue is part of the
 * mined text (cut differently), or holds the mined text plus more of the same language.
 * A bilingual cue that adds a line in another language still translates.
 */
function isSourceLanguageText(translation: string, minedText: string): boolean {
  const compact = (text: string) => text.normalize('NFKC').replace(/\s+/gu, '');
  const candidate = compact(translation);
  const mined = compact(minedText);
  if (!mined) return false;
  if (mined.includes(candidate)) return true;
  if (!candidate.includes(mined)) return false;
  const rest = candidate.split(mined).join('');
  return mainScriptFamily(rest) === null || mainScriptFamily(rest) === mainScriptFamily(mined);
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
  if (!translation || isSourceLanguageText(translation, input.text)) return null;
  return {
    translation,
    translationLines: translationLines.map(({ text, startTime, endTime }) => ({
      text,
      startTime,
      endTime,
    })),
  };
}
