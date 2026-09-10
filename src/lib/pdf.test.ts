import { StandardFonts } from 'pdf-lib';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
} from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { alfeiMenashe, makeDoc, sampleArchive } from '../test/fixtures';
import { pagesFromZip } from './fetchBook';
import { buildDoc } from './parseOcr';
import {
  buildPdf,
  directionalRuns,
  displayWords,
  printedEntries,
  registerCoverage,
  renderable,
} from './pdf';
import { tocEntries, type TocEntry } from './toc';

const doc = buildDoc(await pagesFromZip(sampleArchive()));

const fonts = {
  regular: new Uint8Array(readFileSync(resolve('src/assets/fonts/FrankRuhlLibre-Regular.ttf'))),
  bold: new Uint8Array(readFileSync(resolve('src/assets/fonts/FrankRuhlLibre-Bold.ttf'))),
};

const bytes = await buildPdf(alfeiMenashe, doc, fonts);
// Parsed once at module scope: `await` is not allowed inside describe().
const loaded = await PDFDocument.load(bytes);

describe('text direction', () => {
  it('keeps a pure Hebrew line as one run', () => {
    // fontkit reverses a single RTL run correctly on its own, so body text
    // must not be chopped up unnecessarily.
    expect(directionalRuns('אלפי מנשה חלק א').map((r) => r.text)).toEqual(['אלפי מנשה חלק א']);
  });

  it('gives digits their own run, left of the Hebrew', () => {
    // fontkit reverses anything containing RTL characters, digits included,
    // so "וילנה 1880" came out as "0881 הנליו". Splitting keeps the number
    // intact and places it correctly.
    expect(directionalRuns('וילנה 1880').map((r) => r.text)).toEqual(['1880', 'וילנה ']);
  });

  it('keeps Latin runs intact and forward', () => {
    const runs = directionalRuns('רישיון: Creative Commons BY-SA 4.0').map((r) => r.text);
    expect(runs[0]).toBe('Creative Commons BY-SA 4.0');
    expect(runs).toHaveLength(2);
  });

  it('mirrors brackets inside a right-to-left run', () => {
    // Unicode rule L4. bidi-js returns an empty mirroring map, so this is done
    // by hand; without it the parentheses face the wrong way.
    expect(directionalRuns('ספר (עם סוגריים) כאן')[0].text).toBe('ספר )עם סוגריים( כאן');
  });

  it('does not mirror brackets in a left-to-right run', () => {
    expect(directionalRuns('Creative (Commons)')[0].text).toContain('(Commons)');
  });

  it('orders words right to left within a Hebrew run', () => {
    // Words are placed individually so lines can be justified; the first
    // logical word must end up rightmost, i.e. last in display order.
    expect(displayWords('אלפי מנשה חלק א').map((w) => w.text)).toEqual([
      'א',
      'חלק',
      'מנשה',
      'אלפי',
    ]);
  });

  it('keeps Latin words in their own order while placing them left', () => {
    expect(displayWords('שנת Creative Commons').map((w) => w.text)).toEqual([
      'Creative',
      'Commons',
      'שנת',
    ]);
  });

  it('never hands pdf-lib a pre-reversed line', () => {
    // Reordering a whole line before drawing reverses it twice: the page still
    // looks right but the stored text becomes logical and search breaks in
    // Foxit and Acrobat. Runs are reordered; their text stays logical.
    const source = readFileSync(resolve('src/lib/pdf.ts'), 'utf8');
    expect(source).not.toMatch(/getReorderedString/);
  });
});

describe('PDF output', () => {
  // Assertions run against the parsed document, not the raw bytes: pdf-lib
  // writes object streams, so the structure is compressed and not greppable.
  it('is a valid PDF', () => {
    expect(new TextDecoder('latin1').decode(bytes.slice(0, 5))).toBe('%PDF-');
  });

  it('has a title page, contents pages and body pages', () => {
    expect(loaded.getPageCount()).toBeGreaterThan(3);
  });

  it('records the book metadata', () => {
    expect(loaded.getTitle()).toBe(alfeiMenashe.title);
    expect(loaded.getAuthor()).toBe(alfeiMenashe.author);
  });

  it('carries a real outline so readers show a navigation tree', () => {
    const outlines = loaded.catalog.lookup(PDFName.of('Outlines'), PDFDict);
    expect(outlines).toBeDefined();
    expect(outlines.lookup(PDFName.of('Count'), PDFNumber).asNumber()).toBe(
      tocEntries(doc).length,
    );
    expect(loaded.catalog.get(PDFName.of('PageMode'))).toBe(PDFName.of('UseOutlines'));
  });

  it('links contents entries to their destination pages', () => {
    // Contents pages sit directly after the title page.
    const annots = loaded.getPage(1).node.lookup(PDFName.of('Annots'), PDFArray);
    expect(annots.size()).toBeGreaterThan(0);
    const first = annots.lookup(0, PDFDict);
    expect(first.lookup(PDFName.of('Subtype'))).toBe(PDFName.of('Link'));
  });

  it('embeds the fonts rather than relying on the reader', () => {
    const fontNames = loaded.context
      .enumerateIndirectObjects()
      .flatMap(([, obj]) => (obj instanceof PDFDict ? [obj] : []))
      .filter((d) => d.get(PDFName.of('FontFile2')) !== undefined);
    expect(fontNames.length).toBeGreaterThan(0);
  });

  it('does not choke on a book with no headings', async () => {
    const bare = makeDoc({
      blocks: [{ kind: 'para' as const, page: 1, spans: [{ text: 'טקסט קצר', bold: false }] }],
    });
    const out = await buildPdf(alfeiMenashe, bare, fonts);
    expect(new TextDecoder('latin1').decode(out.slice(0, 5))).toBe('%PDF-');
  });
});


describe('a font that cannot draw what the text contains', () => {
  it('substitutes rather than letting a box reach the page', async () => {
    const { PDFDocument } = await import('pdf-lib');
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.TimesRoman);
    // Stand in for a Hebrew face: Latin-1 and the curly quotes, nothing more.
    registerCoverage(font, {
      unitsPerEm: 1000,
      layout: () => ({ glyphs: [], positions: [] }),
      hasGlyphForCodePoint: (cp: number) => cp <= 0x00ff || cp === 0x2018 || cp === 0x2019,
    });
    // Koren spells Ye'i'el with a Greek dasia and koronis.
    expect(renderable(font, 'Ye\u1FFEi\u1FBDel')).toBe('Ye\u2018i\u2019el');
    expect(renderable(font, 'Ye\u0125i\u1FBDel')).toBe('Yehi\u2019el');
  });
});


describe('how deep the printed contents goes', () => {
  const rows = (level: number, n: number): TocEntry[] =>
    Array.from({ length: n }, (_, i) => ({ text: `h${i}`, page: i, label: String(i), id: `i${i}`, level }));
  /** A Dicta book's headings, which carry no level at all. */
  const unlevelled = (n: number): TocEntry[] =>
    Array.from({ length: n }, (_, i) => ({ text: `h${i}`, page: i, label: String(i), id: `i${i}` }));

  it('prints a Dicta book, whose headings carry no level at all', () => {
    expect(printedEntries(unlevelled(12))).toHaveLength(12);
  });

  it('prints a book whose only headings are chapters', () => {
    // A single Sefaria book numbers chapters at level 3 and has nothing above
    // them. Filtering to a fixed level left it with no contents page at all.
    expect(printedEntries(rows(3, 8))).toHaveLength(8);
  });

  it('stops before a whole Tanakh of chapters', () => {
    const tanakh = [...rows(1, 3), ...rows(2, 39), ...rows(3, 929)];
    expect(printedEntries(tanakh)).toHaveLength(42);
  });

  it('prints the shallowest level however long it runs', () => {
    // Something must be printed, even past the cap.
    expect(printedEntries(rows(1, 400))).toHaveLength(400);
  });
});

describe('emphasis in a face that ships one weight', () => {
  // Taamey D has a single weight, so the bold face is the regular one. A
  // reader and Word synthesise a bold in that situation; a PDF viewer does
  // not, so inline emphasis simply disappeared from the page.
  const emphasised = makeDoc({
    blocks: [
      {
        kind: 'para',
        page: 1,
        spans: [
          { text: 'רגיל', bold: false },
          { text: 'מודגש', bold: true },
        ],
      },
    ],
  });

  /** Every drawing operator in the finished file, as text. */
  async function operators(faces: { regular: Uint8Array; bold: Uint8Array }): Promise<string> {
    const out = await buildPdf(alfeiMenashe, emphasised, faces);
    const parsed = await PDFDocument.load(out);
    const chunks: string[] = [];
    for (const page of parsed.getPages()) {
      const contents = page.node.Contents();
      const streams = contents instanceof PDFArray ? contents.asArray() : [contents];
      for (const entry of streams) {
        const stream = parsed.context.lookup(entry);
        if (stream instanceof PDFRawStream) {
          chunks.push(new TextDecoder().decode(decodePDFRawStream(stream).decode()));
        }
      }
    }
    return chunks.join('\n');
  }

  it('strokes the bold run when there is no bold face to switch to', async () => {
    const ops = await operators({ regular: fonts.regular, bold: fonts.regular });
    // Text rendering mode 2 — fill and stroke — is how a PDF thickens a glyph.
    expect(ops).toMatch(/\b2 Tr\b/);
  });

  it('leaves a two-weight face to its real bold', async () => {
    const ops = await operators(fonts);
    expect(ops).not.toMatch(/\b2 Tr\b/);
  });
});
