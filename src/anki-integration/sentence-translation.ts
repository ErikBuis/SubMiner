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

const SCRIPTS = ['Latin', 'Han', 'Hiragana', 'Katakana', 'Hangul', 'Cyrillic', 'Greek', 'Thai'];

function scriptsOf(text: string): Set<string> {
  return new Set(SCRIPTS.filter((script) => new RegExp(`\\p{Script=${script}}`, 'u').test(text)));
}

/**
 * A secondary track in the primary language is no translation: its cue is part of the
 * mined text (cut differently), or holds the mined text plus only more of the same
 * language. A bilingual cue that adds a line in another script still translates.
 */
function isSourceLanguageText(translation: string, minedText: string): boolean {
  const compact = (text: string) => text.normalize('NFKC').replace(/\s+/gu, '');
  const candidate = compact(translation);
  const mined = compact(minedText);
  if (!mined) return false;
  if (mined.includes(candidate)) return true;
  if (!candidate.includes(mined)) return false;
  const minedScripts = scriptsOf(mined);
  const rest = candidate.split(mined).join('');
  return ![...scriptsOf(rest)].some((script) => !minedScripts.has(script));
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
