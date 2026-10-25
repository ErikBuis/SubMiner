import {
  alignSentenceTranslation,
  findBestOverlappingLine,
  formatCardTranslation,
  joinSubtitleLineTexts,
  sortSubtitleLines,
  type TimedSubtitleText,
} from '../shared/sentence-translation-alignment';

/** Parsed primary and secondary subtitle tracks, in the same timeline as the mined range. */
export interface SubtitleTracksForTranslation {
  primary: readonly TimedSubtitleText[];
  secondary: readonly TimedSubtitleText[];
}

export interface CardSentenceTranslation {
  /** The card sentence; widened to the whole translated sentence when alignment applies. */
  text: string;
  startTime: number;
  endTime: number;
  widened: boolean;
  translation: string;
  /** Secondary lines around the clip, so a review can follow added or removed lines. */
  reviewLines: TimedSubtitleText[];
}

/** Secondary lines further than this from the clip are never offered to the review. */
const REVIEW_LINE_WINDOW_SECONDS = 90;
/** Without alignment, a secondary line counts when this much of it (or of the range) overlaps. */
const OVERLAP_SHARE = 0.5;

function overlappingLines(
  lines: readonly TimedSubtitleText[],
  range: { startTime: number; endTime: number },
): TimedSubtitleText[] {
  const rangeDuration = range.endTime - range.startTime;
  return lines.filter((line) => {
    const overlap =
      Math.min(line.endTime, range.endTime) - Math.max(line.startTime, range.startTime);
    if (overlap <= 0) return false;
    const lineDuration = line.endTime - line.startTime;
    return (
      overlap >= lineDuration * OVERLAP_SHARE ||
      (rangeDuration > 0 && overlap >= rangeDuration * OVERLAP_SHARE)
    );
  });
}

/**
 * Resolves the sentence and translation a mined card gets. With parsed tracks the
 * translation comes from the secondary lines timed against the mined range, and with
 * `align` the sentence widens to the primary lines that one secondary line covers while
 * unrelated overlapping secondary lines are dropped. Without a parsed secondary track,
 * `fallbackTranslation` (the live secondary subtitle) is used.
 */
export function resolveCardSentenceTranslation(input: {
  text: string;
  startTime: number;
  endTime: number;
  tracks: SubtitleTracksForTranslation | null;
  align: boolean;
  format: boolean;
  maxSentenceSeconds: number;
  fallbackTranslation?: string;
}): CardSentenceTranslation {
  const range = { startTime: input.startTime, endTime: input.endTime };
  const secondary = sortSubtitleLines(input.tracks?.secondary ?? []);
  let text = input.text;
  let startTime = input.startTime;
  let endTime = input.endTime;
  let widened = false;
  let translation = input.fallbackTranslation?.trim() ?? '';

  if (secondary.length > 0) {
    const aligned = input.align
      ? alignSentenceTranslation({
          primaryLines: input.tracks?.primary ?? [],
          secondaryLines: secondary,
          startTime: input.startTime,
          endTime: input.endTime,
          widenSentence: true,
          maxSentenceSeconds: input.maxSentenceSeconds,
        })
      : null;
    if (aligned) {
      translation = aligned.translation;
      if (aligned.startTime < input.startTime - 0.001 || aligned.endTime > input.endTime + 0.001) {
        text = aligned.text;
        startTime = Math.min(aligned.startTime, input.startTime);
        endTime = Math.max(aligned.endTime, input.endTime);
        widened = true;
      }
    } else if (input.align) {
      const best = findBestOverlappingLine(secondary, range);
      translation = best ? joinSubtitleLineTexts([best]) : '';
    } else {
      translation = joinSubtitleLineTexts(overlappingLines(secondary, range));
    }
  }

  const reviewLines = secondary
    .filter(
      (line) =>
        line.endTime >= startTime - REVIEW_LINE_WINDOW_SECONDS &&
        line.startTime <= endTime + REVIEW_LINE_WINDOW_SECONDS,
    )
    .map(({ text: lineText, startTime: lineStart, endTime: lineEnd }) => ({
      text: lineText,
      startTime: lineStart,
      endTime: lineEnd,
    }));

  return {
    text,
    startTime,
    endTime,
    widened,
    translation: input.format ? formatCardTranslation(translation) : translation,
    reviewLines,
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
