// A bracketed label at the start of a subtitle line, e.g. （ひとり） or (Hitori). Subtitle
// authors use these to name the speaker or to describe a sound, so they are not part of
// what was said.
const LEADING_LABEL = /^[ \t　]*(?:[（(][^（）()\n]+[）)][ \t　]*)+/;

/**
 * Removes speaker names and similar annotations written in full-width or half-width
 * brackets at the start of a subtitle line. A line holding only a label is dropped; when
 * nothing else would be left, the text is returned unchanged so the card never ends up
 * with an empty sentence.
 */
export function stripSpeakerLabels(text: string): string {
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    const stripped = line.replace(LEADING_LABEL, '');
    if (stripped === line) {
      kept.push(line);
    } else if (stripped.trim().length > 0) {
      kept.push(stripped);
    }
  }
  const result = kept.join('\n').trim();
  return result.length > 0 ? result : text;
}

/** Applies {@link stripSpeakerLabels} unless `ankiConnect.behavior.stripSpeakerLabels` is off. */
export function cleanSentenceText(
  text: string,
  behavior: { stripSpeakerLabels?: boolean } | undefined,
): string {
  return behavior?.stripSpeakerLabels === false ? text : stripSpeakerLabels(text);
}
