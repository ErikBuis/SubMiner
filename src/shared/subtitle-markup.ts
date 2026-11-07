const NAMED_CHARACTER_REFERENCES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
};

/** Numeric references and the named ones Anki's editor writes; anything else stays as is. */
function decodeCharacterReference(reference: string, body: string): string {
  if (body.startsWith('#')) {
    const hex = body[1] === 'x' || body[1] === 'X';
    const codePoint = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
    return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : reference;
  }
  return NAMED_CHARACTER_REFERENCES[body.toLowerCase()] ?? reference;
}

/** Decodes HTML character references (`&amp;`, `&#39;`) in subtitle or field text. */
export function decodeCharacterReferences(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, decodeCharacterReference);
}

/** An HTML-style tag (`<i>`, `</font>`); a literal `<` in text such as `1 < 2` is not one. */
export const HTML_SUBTITLE_TAG_PATTERN = /<\/?[A-Za-z][^>\n]*>/g;

/** Removes HTML-style tags, keeping literal comparison signs. */
export function stripSubtitleTags(text: string): string {
  return text.replace(HTML_SUBTITLE_TAG_PATTERN, '');
}
