/**
 * The Hebrew marks a face without cantillation cannot set.
 *
 * Frank Ruhl Libre has every Hebrew vowel — meteg included — but **not one** of
 * the 31 te'amim, nor the three rare marks below. A glyph the font lacks is a
 * box in a PDF and in any EPUB reader that honours the embedded font, so a
 * verse of Tanakh came out as `לְרֵ □יחַ □שְׁמָנֶ □יךָ`.
 *
 * Stripping them is now the fallback rather than the rule. An accented text is
 * set in Noto Serif Hebrew, which has all 31 and positions them by GPOS, and
 * keeps its accents; see ./cantillation for how that is decided. This is for
 * what is still set in Frank Ruhl Libre, where a box would be worse than a
 * missing chant — the trade a printed commentary usually makes anyway: a
 * Miqraot Gedolot sets the te'amim, a Malbim on its own generally does not.
 *
 * The DOCX asks for FrankRuehl, which Windows ships and which does have all
 * 31, so it strips nothing. Nor does the reader: a browser falls back to a
 * system Hebrew font per missing glyph.
 */
const UNSUPPORTED =
  // U+0591–U+05AF: the te'amim. U+05C4/05C5: the puncta extraordinaria.
  // U+05C6: nun hafukha, which the font also has no glyph for.
  /[֑-֯ׄ-׆]/g;

export function stripUnsupportedMarks(text: string): string {
  return text.replace(UNSUPPORTED, '');
}

/** Whether a string carries any of them — used only by the tests. */
export function hasUnsupportedMarks(text: string): boolean {
  UNSUPPORTED.lastIndex = 0;
  return UNSUPPORTED.test(text);
}
