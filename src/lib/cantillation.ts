import type { BookDoc } from './types';

/**
 * Te'amim — the cantillation marks, U+0591 to U+05AF.
 *
 * Deliberately not the whole of the Hebrew block: nikud (U+05B0 and up) is
 * ordinary pointing that every Hebrew face sets. Only the accents need a font
 * chosen for them, and only they justify loading a second one.
 */
const TAAMIM = /[\u0591-\u05AF]/u;

export function textHasCantillation(text: string): boolean {
  return TAAMIM.test(text);
}

/**
 * Whether a book needs a face that can set te'amim.
 *
 * True for a pointed Tanakh, and also for a commentary that quotes verses with
 * their accents — which is why this asks the text rather than the catalogue.
 * Short-circuits, so a cantillated book is decided by its first verse.
 */
export function hasCantillation(doc: BookDoc): boolean {
  return doc.blocks.some((b) => b.spans.some((s) => TAAMIM.test(s.text)));
}
