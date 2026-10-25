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
  });
  const best = aligned ? null : findBestOverlappingLine(secondary, input);
  const translationLines = aligned?.translationLines ?? (best ? [best] : []);
  const translation = joinSubtitleLineTexts(translationLines);
  // A secondary track in the same language as the primary one is no translation.
  const compact = (text: string) => text.replace(/\s+/g, '');
  if (!translation || compact(translation) === compact(input.text)) return null;
  return {
    translation,
    translationLines: translationLines.map(({ text, startTime, endTime }) => ({
      text,
      startTime,
      endTime,
    })),
  };
}
