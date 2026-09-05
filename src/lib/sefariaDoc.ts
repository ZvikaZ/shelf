import type { Attribution } from './attribution';
import type { Block, BookDoc, Span } from './types';

/**
 * Turning Sefaria's JSON into the same block list the Dicta OCR parser
 * produces.
 *
 * Sefaria stores a book as a "jagged array": nested arrays of strings, one
 * nesting level per address in a reference. `Genesis` is [chapter][verse];
 * `Rashi on Berakhot` is [daf][line][comment]. The leaves are HTML fragments.
 */

/** A text node in the book's schema — the unit a single API call returns. */
export interface TextNode {
  /** Hebrew title of the section this node covers, if it has one of its own. */
  heTitle?: string;
  /** e.g. ['Chapter', 'Verse'] — one name per level of the jagged array. */
  sectionNames: string[];
  addressTypes: string[];
  text: JaggedText;
}

export type JaggedText = string | JaggedText[];

/**
 * Hebrew section numbering. Sefaria addresses a Talmud page as `5a`, and
 * everything else by an ordinal, but Hebrew books are numbered with letters.
 */
const LETTERS = 'א,ב,ג,ד,ה,ו,ז,ח,ט'.split(',');
const TENS = 'י,כ,ל,מ,נ,ס,ע,פ,צ'.split(',');
const HUNDREDS = 'ק,ר,ש,ת'.split(',');

export function hebrewNumber(n: number): string {
  if (!Number.isFinite(n) || n < 1) return String(n);
  let rest = n;
  let out = '';
  while (rest >= 500) {
    out += 'ת';
    rest -= 400;
  }
  if (rest >= 100) {
    out += HUNDREDS[Math.floor(rest / 100) - 1];
    rest %= 100;
  }
  // 15 and 16 are written טו and טז, never יה or יו, which spell the Name.
  if (rest === 15) return out + 'טו';
  if (rest === 16) return out + 'טז';
  if (rest >= 10) {
    out += TENS[Math.floor(rest / 10) - 1];
    rest %= 10;
  }
  if (rest >= 1) out += LETTERS[rest - 1];
  return out;
}

/** `5a` → `ה ע"א`. Sefaria counts dapim from 1, where daf 1 is the title page. */
export function talmudAddress(index: number): string {
  const daf = Math.floor(index / 2) + 1;
  return `${hebrewNumber(daf)} ${index % 2 === 0 ? 'ע"א' : 'ע"ב'}`;
}

/** The label for one level of a reference, e.g. `ג` or `ה ע"א`. */
function address(addressType: string, index: number): string {
  return addressType === 'Talmud' ? talmudAddress(index) : hebrewNumber(index + 1);
}

// ---------------------------------------------------------------------------
// Inline markup
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  // The space family. Sefaria sets a thin space either side of a paseq, and
  // pads the end of a verse with non-breaking ones; both collapse away here.
  nbsp: ' ',
  thinsp: ' ',
  hairsp: ' ',
  ensp: ' ',
  emsp: ' ',
  // Invisible controls: dropped rather than left as literal text.
  shy: '',
  zwj: '',
  zwnj: '',
  lrm: '',
  rlm: '',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  middot: '·',
  bull: '•',
  deg: '°',
  times: '×',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  prime: '′',
  Prime: '″',
};

function decode(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const cp =
        code[1] === 'x' || code[1] === 'X'
          ? Number.parseInt(code.slice(2), 16)
          : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

const TAG = /<\/?([a-z]+)((?:\s+[a-z-]+(?:="[^"]*")?)*)\s*\/?>/gi;

/**
 * Sefaria segments carry a small set of inline tags. We keep the one thing the
 * block model can express — bold — and drop the rest to plain text.
 *
 * `<i data-commentator>` is an empty anchor marking where a commentary hangs
 * off the text, and carries no words of its own; a footnote is a `<sup>` marker
 * followed by an `<i class="footnote">` body, which belongs in neither the
 * running text nor a heading. Both are dropped. `<br>` ends the paragraph,
 * because these books use it where prose would use a paragraph break.
 */
type Piece = { text: string; bold: boolean } | { br: true };

export function spansFromHtml(html: string): { spans: Span[]; breaks: number[] } {
  const pieces: Piece[] = [];
  let bold = 0;
  let at = 0;
  // Tags whose contents are apparatus rather than text, innermost last.
  const skipping: string[] = [];

  // Whitespace is collapsed but deliberately not trimmed: whether a space sat
  // either side of a tag is the only thing that says if it split a word.
  const push = (raw: string) => {
    if (skipping.length > 0 || raw === '') return;
    pieces.push({ text: decode(raw).replace(/\s+/g, ' '), bold: bold > 0 });
  };

  TAG.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG.exec(html)) !== null) {
    push(html.slice(at, m.index));
    at = m.index + m[0].length;

    const tag = m[1].toLowerCase();
    const closing = m[0][1] === '/';
    const attrs = m[2] ?? '';

    if (closing) {
      if (skipping[skipping.length - 1] === tag) skipping.pop();
      else if (skipping.length === 0 && (tag === 'b' || tag === 'strong')) {
        bold = Math.max(0, bold - 1);
      }
      continue;
    }

    if (tag === 'br') {
      if (skipping.length === 0) pieces.push({ br: true });
      continue;
    }
    if (isApparatus(tag, attrs)) {
      skipping.push(tag);
      continue;
    }
    if (skipping.length === 0 && (tag === 'b' || tag === 'strong')) bold += 1;
  }
  push(html.slice(at));

  return fold(pieces);
}

/**
 * Markup that is notation *about* the text rather than part of it.
 *
 * A footnote is a `<sup>` marker plus an `<i class="footnote">` body;
 * `<i data-commentator>` is an empty anchor where a commentary hangs off the
 * text. `mam-spi-*` wraps the Masoretic section markers `{פ}` and `{ס}`, which
 * mark a paragraph break in a scroll — real notation, but it renders as literal
 * braces mid-verse once you strip the styling that makes it legible.
 *
 * Deliberately *not* apparatus: `mam-kq` (ketiv/qere) already reads correctly,
 * as `(הוצא) [הַיְצֵא]` — parenthesised written form, bracketed read form, which is
 * how a printed Tanakh sets it — and `mam-implicit-maqaf`, which supplies a
 * real maqaf between words.
 */
function isApparatus(tag: string, attrs: string): boolean {
  if (tag === 'sup') return true;
  if (tag === 'i') return /footnote|data-commentator/i.test(attrs);
  if (tag === 'span') return /mam-spi/i.test(attrs);
  return false;
}

/**
 * Fold the pieces into spans, under one invariant: **a span boundary only ever
 * falls where the source had whitespace.**
 *
 * Everything downstream rejoins spans with a single space, so a boundary in the
 * middle of a word would insert one that was never there — `<big>בְּ</big>רֵאשִׁית`
 * becoming `בְּ רֵאשִׁית`. Where emphasis changes mid-word the word wins and the
 * emphasis is absorbed, which is invisible in the output; a broken word is not.
 */
function fold(pieces: Piece[]): { spans: Span[]; breaks: number[] } {
  const raw: Span[] = [];
  const rawBreaks: number[] = [];
  let forceBreak = false;

  for (const piece of pieces) {
    if ('br' in piece) {
      if (raw.length) {
        rawBreaks.push(raw.length);
        forceBreak = true;
      }
      continue;
    }
    if (!piece.text) continue;

    const last = raw[raw.length - 1];
    const spaced = last?.text.endsWith(' ') || piece.text.startsWith(' ');
    if (!last || forceBreak || (last.bold !== piece.bold && spaced)) {
      raw.push({ text: piece.text, bold: piece.bold });
    } else {
      last.text += piece.text;
    }
    forceBreak = false;
  }

  // Trim only now, at the boundaries, and carry the break positions across.
  const spans: Span[] = [];
  const moved = new Map<number, number>();
  raw.forEach((span, i) => {
    moved.set(i, spans.length);
    const text = span.text.trim();
    if (text) spans.push({ text, bold: span.bold });
  });

  const breaks = [...new Set(rawBreaks.map((i) => moved.get(i) ?? spans.length))].filter(
    (i) => i > 0 && i < spans.length,
  );
  return { spans, breaks };
}

/** Split one segment's spans into paragraphs at its `<br>` boundaries. */
function paragraphs(html: string): Span[][] {
  const { spans, breaks } = spansFromHtml(html);
  if (spans.length === 0) return [];
  if (breaks.length === 0) return [spans];

  const out: Span[][] = [];
  let from = 0;
  for (const at of [...breaks, spans.length]) {
    if (at > from) out.push(spans.slice(from, at));
    from = at;
  }
  return out.filter((p) => p.length > 0);
}

// ---------------------------------------------------------------------------
// Flattening
// ---------------------------------------------------------------------------

/** Sefaria leaves gaps where a version has no text for a section. */
function isEmpty(node: JaggedText): boolean {
  return Array.isArray(node) ? node.every(isEmpty) : node.trim() === '';
}

interface Cursor {
  blocks: Block[];
  /** Citation slot: one per addressable section, in reading order. */
  slot: number;
}

/**
 * Walk one node's jagged array, emitting a heading per section and a paragraph
 * per segment.
 *
 * Depth varies across the library — 2 for `Chapter/Verse`, 3 for
 * `Daf/Line/Comment` — so this recurses on the array rather than assuming a
 * shape. Only the outermost level becomes a heading: below that the numbering
 * is dense enough that a heading per verse would drown the text.
 *
 * `numberSections` is off for a *flat* named leaf of a complex book — one
 * whose outermost level already is its paragraphs, where numbering them
 * would bury the section's one real heading (see the call site in
 * `buildSefariaDoc`, which is what actually decides this per leaf).
 */
function walk(
  node: JaggedText,
  path: number[],
  text: TextNode,
  cur: Cursor,
  numberSections: boolean,
  sectionNames: Record<string, string>,
): void {
  if (!Array.isArray(node)) {
    for (const spans of paragraphs(node)) {
      cur.blocks.push({ kind: 'para', spans, page: cur.slot, label: labelFor(path, text) });
    }
    return;
  }

  node.forEach((child, i) => {
    if (isEmpty(child)) return;
    const next = [...path, i];
    if (numberSections && next.length === 1 && node.length > 1) {
      cur.slot += 1;
      cur.blocks.push({
        kind: 'heading',
        spans: [{ text: sectionTitle(text, i, sectionNames), bold: false }],
        page: cur.slot,
        label: labelFor(next, text),
      });
    }
    walk(child, next, text, cur, numberSections, sectionNames);
  });
}

/** e.g. `פרק ג` — the section name in Hebrew, with its Hebrew number. */
function sectionTitle(text: TextNode, index: number, sectionNames: Record<string, string>): string {
  const raw = text.sectionNames[0];
  const name = sectionNames[raw] ?? raw ?? '';
  return `${name} ${address(text.addressTypes[0] ?? 'Integer', index)}`.trim();
}

/** The citation printed in the margin, e.g. `ג׳:י״ב`. */
function labelFor(path: number[], text: TextNode): string {
  return path.map((i, depth) => address(text.addressTypes[depth] ?? 'Integer', i)).join(':');
}

export const HE_SECTION: Record<string, string> = {
  Chapter: 'פרק',
  Verse: 'פסוק',
  Daf: 'דף',
  Siman: 'סימן',
  Seif: 'סעיף',
  Halakhah: 'הלכה',
  Mishnah: 'משנה',
  Paragraph: 'פסקה',
  Section: 'חלק',
  Line: 'שורה',
  Comment: 'פירוש',
  Perek: 'פרק',
  Pasuk: 'פסוק',
};

/**
 * Fold one or more text nodes into a book.
 *
 * A "simple" book is a single node. A "complex" one — the Haggadah, the Zohar —
 * is a tree of named nodes, each fetched separately; there the node's own title
 * is the heading, which is better structure than anything derivable from the
 * text.
 */
export function buildSefariaDoc(
  nodes: TextNode[],
  attribution: Attribution,
  sectionNames: Record<string, string> = HE_SECTION,
): BookDoc {
  const cur: Cursor = { blocks: [], slot: 0 };

  for (const node of nodes) {
    if (isEmpty(node.text)) continue;
    const named = Boolean(node.heTitle);
    if (named) {
      cur.slot += 1;
      cur.blocks.push({
        kind: 'heading',
        spans: [{ text: node.heTitle as string, bold: false }],
        page: cur.slot,
        // No `label`: a named section's title IS its citation — there is no
        // separate folio or "ג׳:י״ב"-style reference to print alongside it,
        // unlike a numbered chapter. Leaving it unset falls back to the slot
        // number (see `blockLabel`) instead of repeating the heading text a
        // second time, which is what showed up as every entry in the
        // contents being printed twice.
      });
    }
    // A named leaf is usually flat (Ushpizin: just paragraphs), where
    // numbering the outermost level would number every paragraph and drown
    // the section's one real heading in "פסקה 1", "פסקה 2"... But a named
    // leaf can itself be multi-level (Orot's "ארץ ישראל" is Chapter then
    // Paragraph, eight real chapters under that one title) — there the
    // outermost level is chapters, not paragraphs, and skipping their
    // numbers collapses the whole section into one undifferentiated block
    // of text. Only suppress numbering when the leaf is both named and flat.
    const numberSections = !(named && node.sectionNames.length <= 1);
    walk(node.text, [], node, cur, numberSections, sectionNames);
  }

  return {
    blocks: cur.blocks,
    pageCount: cur.slot,
    // Sefaria's structure is explicit, so there is never anything to infer.
    fidelity: 'heading',
    attribution,
  };
}
