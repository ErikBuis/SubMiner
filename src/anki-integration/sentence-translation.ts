import {
  alignSentenceTranslation,
  assignLineTranslations,
  collectOverlappingLines,
  findBestOverlappingLine,
  formatCardTranslation,
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

export interface CardSentenceTranslation {
  /** The card sentence; widened to the whole translated sentence when alignment applies. */
  text: string;
  startTime: number;
  endTime: number;
  widened: boolean;
  translation: string;
  /** Secondary lines around the clip, so a review can follow added or removed lines. */
  reviewLines: TimedSubtitleText[];
  /** The parsed secondary lines `translation` was built from; empty for the fallback. */
  translationLines: TimedSubtitleText[];
  /** With `align`: each primary line around the clip and its full-track translation. */
  lineTranslations: Array<{
    startTime: number;
    endTime: number;
    lines: TimedSubtitleText[];
  }>;
}

/** Secondary lines this close to the clip always reach the review. */
const REVIEW_LINE_WINDOW_SECONDS = 90;
/**
 * Resolves the sentence and translation a mined card gets. With parsed tracks the
 * translation comes from the secondary lines timed against the mined range, and with
 * `align` the sentence widens to the primary lines that one secondary line covers while
 * unrelated overlapping secondary lines are dropped. Without a parsed secondary track,
 * or without alignment when `preferFallbackTranslation` is set, `fallbackTranslation`
 * (the live secondary subtitle) is used; the parsed track still feeds `reviewLines`.
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
  preferFallbackTranslation?: boolean;
}): CardSentenceTranslation {
  const range = { startTime: input.startTime, endTime: input.endTime };
  const secondary = sortSubtitleLines(input.tracks?.secondary ?? []);
  let text = input.text;
  let startTime = input.startTime;
  let endTime = input.endTime;
  let widened = false;
  let translation = input.fallbackTranslation?.trim() ?? '';

  let translationLines: TimedSubtitleText[] = [];
  // Even an empty fallback is kept: mining drops a secondary line equal to the primary one.
  const keepFallback = !input.align && input.preferFallbackTranslation === true;
  if (secondary.length > 0 && !keepFallback) {
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
      translationLines = aligned.translationLines;
      const unionStart = Math.min(aligned.startTime, input.startTime);
      const unionEnd = Math.max(aligned.endTime, input.endTime);
      const withinCap =
        input.maxSentenceSeconds <= 0 || unionEnd - unionStart <= input.maxSentenceSeconds + 0.001;
      if (
        withinCap &&
        (aligned.startTime < input.startTime - 0.001 || aligned.endTime > input.endTime + 0.001)
      ) {
        text = aligned.text;
        startTime = unionStart;
        endTime = unionEnd;
        widened = true;
      }
    } else if (input.align) {
      const best = findBestOverlappingLine(secondary, range);
      translationLines = best ? [best] : [];
    } else {
      translationLines = collectOverlappingLines(secondary, range);
    }
    translation = joinSubtitleLineTexts(translationLines);
  }

  // The review can add any primary line it offers, so the window spans those as well.
  const primary = sortSubtitleLines(input.tracks?.primary ?? []);
  const offeredBefore = primary
    .filter((line) => line.endTime <= startTime + REVIEW_CONTEXT_EPSILON_SECONDS)
    .slice(-REVIEW_CONTEXT_LINE_LIMIT);
  const offeredAfter = primary
    .filter((line) => line.startTime >= endTime - REVIEW_CONTEXT_EPSILON_SECONDS)
    .slice(0, REVIEW_CONTEXT_LINE_LIMIT);
  const windowStart = Math.min(
    startTime - REVIEW_LINE_WINDOW_SECONDS,
    offeredBefore[0]?.startTime ?? Infinity,
  );
  const windowEnd = Math.max(
    endTime + REVIEW_LINE_WINDOW_SECONDS,
    ...offeredAfter.map((line) => line.endTime),
  );
  const nearClip = (line: TimedSubtitleText): boolean =>
    line.endTime >= windowStart && line.startTime <= windowEnd;
  const reviewLines = secondary.filter(nearClip).map(toPlainLine);
  const lineTranslations =
    input.align && secondary.length > 0
      ? assignLineTranslations(primary, secondary)
          .filter(({ line }) => nearClip(line))
          .map(({ line, translationLines: lines }) => ({
            startTime: line.startTime,
            endTime: line.endTime,
            lines: lines.map(toPlainLine),
          }))
      : [];

  return {
    text,
    startTime,
    endTime,
    widened,
    translation: input.format ? formatCardTranslation(translation) : translation,
    reviewLines,
    translationLines: translationLines.map(toPlainLine),
    lineTranslations,
  };
}

function toPlainLine({ text, startTime, endTime }: TimedSubtitleText): TimedSubtitleText {
  return { text, startTime, endTime };
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
