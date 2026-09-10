import { describe, expect, it } from 'vitest';
import { substituteUnsupported, UNSUPPORTED_LATIN } from './transliteration';

/** Stand-in for Taamey Frank: Latin-1 and the curly quotes, nothing beyond. */
const taameyFrankish = (cp: number) => cp <= 0x00ff || cp === 0x2018 || cp === 0x2019;

describe('characters a Hebrew face cannot set', () => {
  it('replaces the marks the Koren transliteration uses', () => {
    // Aleph and ayin are Greek breathing marks, ḥet an h with a circumflex.
    // Taamey Frank has none of the three, so they came out as boxes: 3,186
    // occurrences in three books alone.
    const source = 'Yisra\u1FBDel Ye\u1FFEi\u1FBDel Ye\u0125i\u1FBDel \u1E24aggai \u017Cakkur';
    const out = substituteUnsupported(source, taameyFrankish);
    for (const ch of out) {
      expect(taameyFrankish(ch.codePointAt(0)!)).toBe(true);
    }
  });

  it('keeps aleph and ayin apart rather than flattening both to one mark', () => {
    const out = substituteUnsupported('\u1FBD\u1FFE', taameyFrankish);
    expect(out[0]).not.toBe(out[1]);
  });

  it('leaves text the font can already set completely alone', () => {
    const plain = 'And he distributed to every one of them, both men and women.';
    expect(substituteUnsupported(plain, taameyFrankish)).toBe(plain);
  });

  it('never loses a character, so no two words run together', () => {
    // The word was being dropped whole, which closed the gap around it.
    const source = 'of Yisra\u1FBDel both men';
    const out = substituteUnsupported(source, taameyFrankish);
    expect(out.split(' ')).toHaveLength(4);
    expect(out).toContain(' both ');
  });

  it('drops a soft hyphen rather than drawing something for it', () => {
    expect(substituteUnsupported('re\u00ADmember', taameyFrankish)).toBe('remember');
  });

  it('substitutes anything unmapped rather than leaving it unrenderable', () => {
    // An unknown character must still not reach the page as a box.
    const out = substituteUnsupported('a\u4E2Db', taameyFrankish);
    expect(out).not.toContain('\u4E2D');
    expect(out.startsWith('a')).toBe(true);
    expect(out.endsWith('b')).toBe(true);
  });

  it('keeps a separator visible when the font has no middle dot', () => {
    // Taamey D has none, and a silently dropped separator ran the running
    // head's title and chapter together.
    const noMiddleDot = (cp: number) => taameyFrankish(cp) && cp !== 0x00b7;
    const out = substituteUnsupported('Genesis · Chapter 5', noMiddleDot);
    expect(out).toBe('Genesis - Chapter 5');
  });

  it('lists what the Koren text actually needs', () => {
    for (const cp of [0x1fbd, 0x1ffe, 0x0125, 0x017c, 0x1e24, 0x017b]) {
      expect(UNSUPPORTED_LATIN[String.fromCodePoint(cp)]).toBeDefined();
    }
  });
});
