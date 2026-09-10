/**
 * Latin characters a Hebrew face has no glyph for.
 *
 * The Koren translation transliterates names with marks a Hebrew typeface has
 * no reason to carry: Greek breathing marks for aleph and ayin, and dotted or
 * circumflexed letters for ḥet and zayin. Three books alone contain 3,186 of
 * them, and every one reached the page as a box.
 *
 * Substituting is a loss — the transliteration is less precise — but a legible
 * approximation beats a row of boxes, and aleph and ayin stay distinguishable
 * from each other, which is the distinction that carries meaning.
 */
export const UNSUPPORTED_LATIN: Record<string, string> = {
  '\u1FBD': '\u2019', // ᾽ koronis, standing for aleph
  '\u1FFE': '\u2018', // ῾ dasia, standing for ayin
  '\u02BE': '\u2019',
  '\u02BF': '\u2018',
  '\u0125': 'h', // ĥ
  '\u0124': 'H',
  '\u1E25': 'h', // ḥ
  '\u1E24': 'H',
  '\u017C': 'z', // ż
  '\u017B': 'Z',
  '\u00AD': '', // soft hyphen: a line-break hint, not a character
  '\u2013': '-',
  '\u2014': '-',
  // Separators. A Hebrew face often has no middle dot, and dropping it runs
  // the two things it separated together \u2014 the running head lost the gap
  // between the book's title and its chapter.
  '\u00b7': '-',
  '\u2022': '-',
};

/** Zero-width and formatting characters, which carry no ink in any font. */
const INVISIBLE = new Set([0x00ad, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff]);

/**
 * Rewrite `text` so every character is one the font can actually draw.
 *
 * Anything unmapped is decomposed and stripped of its marks, keeping whatever
 * survives — so an unforeseen character degrades to its base letter rather than
 * to a box, and never to nothing at all, which would run its neighbours
 * together.
 */
export function substituteUnsupported(text: string, has: (codePoint: number) => boolean): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    // Invisible formatting characters go whether or not the font has a glyph:
    // they are hints to a layout engine we are not running.
    if (cp !== undefined && INVISIBLE.has(cp)) continue;
    if (cp === undefined || has(cp)) {
      out += ch;
      continue;
    }
    const mapped = UNSUPPORTED_LATIN[ch];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    const folded = ch.normalize('NFD').replace(/\p{M}/gu, '');
    out += [...folded].filter((c) => has(c.codePointAt(0)!)).join('');
  }
  return out;
}
