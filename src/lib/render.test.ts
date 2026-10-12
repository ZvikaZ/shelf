import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { alfeiMenashe, makeDoc, sampleArchive } from '../test/fixtures';
import { buildDocx } from './docx';
import { obfuscate } from './docxFont';
import { buildEpub, chapterise } from './epub';
import { pagesFromZip } from './fetchBook';
import { blockText, buildDoc } from './parseOcr';
import { hebrewNumber } from './sefariaDoc';
import { shouldIncludeToc, tocEntries } from './toc';
import type { BookDoc } from './types';

const pages = await pagesFromZip(sampleArchive());
const doc = buildDoc(pages);
const builtEpub = await buildEpub(alfeiMenashe, doc);
const epubZip = await JSZip.loadAsync(builtEpub);

/** Strip tags from the raw OCR html so we can compare against what we emit. */
function rawText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, '');
}

function squash(s: string): string {
  return s.replace(/\s+/g, '');
}

function parseXml(xml: string): Document {
  const dom = new DOMParser().parseFromString(xml, 'application/xml');
  const err = dom.querySelector('parsererror');
  if (err) throw new Error(err.textContent ?? 'malformed XML');
  return dom;
}

describe('OCR parsing', () => {
  it('reads every page of the archive in printed order', () => {
    expect(pages).toHaveLength(10);
    expect(pages[0].name).toContain('-002');
    expect(doc.pageCount).toBe(10);
  });

  it('loses no text from the source pages', () => {
    const source = pages.map((p) => rawText(p.html)).join('');
    const parsed = squash(doc.blocks.map(blockText).join(''));
    expect(parsed).toBe(source);
  });

  it('detects the structural tier the book actually carries', () => {
    // אלפי מנשה has bold and marked-paragraph but no explicit `heading` class.
    expect(doc.fidelity).toBe('bold');
  });

  it('promotes bold runs that a paragraph break closes', () => {
    const headings = doc.blocks.filter((b) => b.kind === 'heading').map(blockText);
    expect(headings.length).toBeGreaterThan(0);
    for (const h of headings) expect(h.split(' ').length).toBeLessThanOrEqual(12);
    // A bolded lead-word that runs straight on into its paragraph is emphasis,
    // not a title.
    expect(headings).not.toContain('הנה');
  });

  it('catches run-in headings that close the previous paragraph', () => {
    // On folio 7 the title "ענין הטבעים ב" sits at the END of the preceding
    // paragraph: the OCR marks the break after it, not before. Requiring a
    // heading to *open* a paragraph silently swallowed these.
    const headings = doc.blocks.filter((b) => b.kind === 'heading').map(blockText);
    expect(headings).toContain('ענין הטבעים ב');
    expect(headings).toContain('ידיעות כסדר מחלקי הבריאה א');
  });

  it('keeps non-heading bold as emphasis instead of discarding it', () => {
    const emphasised = doc.blocks
      .filter((b) => b.kind === 'para')
      .flatMap((b) => b.spans)
      .filter((s) => s.bold);
    expect(emphasised.length).toBeGreaterThan(0);
    for (const s of emphasised) expect(s.text.trim()).not.toBe('');
  });

  it('merges adjacent words of the same style into one span', () => {
    const d = buildDoc([
      {
        name: 'm-001__ocr_data.html',
        html:
          '<span class="marked-paragraph">רגיל</span><span> </span><span>עוד</span>' +
          '<span> </span><span class="bold">מודגש</span><span> </span>' +
          '<span class="bold">שוב</span><span> </span><span>סוף</span>',
      },
    ]);
    expect(d.blocks[0].spans).toEqual([
      { text: 'רגיל עוד', bold: false },
      { text: 'מודגש שוב', bold: true },
      { text: 'סוף', bold: false },
    ]);
  });

  it('attributes each block to the page it starts on', () => {
    const seen = doc.blocks.map((b) => b.page);
    expect(Math.min(...seen)).toBe(2);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });

  it('falls back to page units when a book carries no structural markup', () => {
    const bare = buildDoc([
      { name: 'x-001__ocr_data.html', html: '<span>אחד</span><span> </span><span>שנים</span>' },
      { name: 'x-002__ocr_data.html', html: '<span>שלשה</span>' },
    ]);
    expect(bare.fidelity).toBe('pages');
    // With no paragraph marks at all, the page itself is the unit — otherwise
    // the whole book collapses into a single block.
    expect(bare.blocks).toHaveLength(2);
    expect(bare.blocks.every((b) => b.kind === 'para')).toBe(true);
    expect(blockText(bare.blocks[0])).toBe('אחד שנים');
  });

  it('falls back to page units when paragraph marks are too scarce to rely on', () => {
    // Avnei Nezer YD: 539 pages, not one paragraph mark, but a stray heading
    // word on one page — enough to skip the bare-book fallback above and run
    // the whole book into a single 2.4-million-character paragraph.
    const sparse = buildDoc([
      { name: 'a-001__ocr_data.html', html: '<span class="heading">סימן</span><span> </span><span>אחד</span>' },
      { name: 'a-002__ocr_data.html', html: '<span>שנים</span>' },
      { name: 'a-003__ocr_data.html', html: '<span>שלשה</span>' },
    ]);
    expect(sparse.blocks.map((b) => [b.kind, blockText(b)])).toEqual([
      ['heading', 'סימן'],
      ['para', 'אחד'],
      ['para', 'שנים'],
      ['para', 'שלשה'],
    ]);
  });

  describe('numbered simanim in a book with no structure', () => {
    // Avnei Nezer YD: no paragraph marks, so its only structure is the text's
    // own "סימן N" — among hundreds of "סימן אחד" and citations to other books.
    const spans = (text: string, cls = '') =>
      text
        .split('|')
        .map((t) => `<span${cls ? ` class="${cls}"` : ''}>${t}</span><span> </span>`)
        .join('');
    const book = buildDoc([
      { name: 'n-001__ocr_data.html', html: spans('סימן|א|שאלה.|נשחט|רובו|של|סימן|אחד.|הק\'|אברהם.|סימן|ב|ב"ה|יום') },
      // A title in one OCR box, a citation, and a stray heading-class word.
      { name: 'n-002__ocr_data.html', html: spans('סימן ג|כמבואר|בש"ך|סימן|קי"ט|וצ"ע:') + spans('עם', 'heading') },
      // ד is misread, but it sits where a title sits: right after a colon.
      { name: 'n-003__ocr_data.html', html: spans('סימן|שדמ|א)|ראוי|לבאר.|סימן|ה|ב"ה|והנה') },
      { name: 'n-004__ocr_data.html', html: spans('דבריו:|סימן|ו|שלום|לכבוד') },
    ]);
    const headings = book.blocks.filter((b) => b.kind === 'heading').map(blockText);

    it('heads each siman by its place in the sequence', () => {
      expect(headings).toEqual(['סימן א', 'סימן ב', 'סימן ג', 'סימן ד', 'סימן ה', 'סימן ו']);
    });

    it('keeps the text around a title where it was', () => {
      const text = book.blocks.map(blockText).join(' | ');
      expect(text).toContain('הק\' אברהם. | סימן ב | ב"ה יום');
      expect(text).toContain('סימן ד | א) ראוי לבאר.');
      expect(text).toContain('בש"ך סימן קי"ט');
    });

    it('prefers a bold or abbreviated title to a citation of the same number', () => {
      // Be'er Yitzchak heads its responsa `סי' א` in bold, and later cites
      // `בסוף סימן א' לעיל` — a plain citation that must not take the title's place.
      const b = buildDoc([
        { name: 'b-001__ocr_data.html', html: spans('באר|יצחק') + spans("סי'|א", 'bold') + spans('שאלה|באחד|כנ"ל:') + spans("סי'|ב'", 'bold') + spans('בענין') },
        { name: 'b-002__ocr_data.html', html: spans('כמו|שכתבתי|בסוף|סימן|א\'|לעיל.|סימן|ג|אל|כבוד.|סימן|ד|שאלה.|סימן|ה|ונחזור') },
        // Past the last title, a citation a few numbers on (Tzemach Tzedek's
        // `סי' צ"ו` after its last title, צג).
        { name: 'b-003__ocr_data.html', html: spans('ובספר|יראים|סי\'|ח\'|והיש"ש') },
      ]);
      const titles = b.blocks.filter((x) => x.kind === 'heading');
      expect(titles.map(blockText)).toEqual(['סימן א', 'סימן ב', 'סימן ג', 'סימן ד', 'סימן ה']);
      expect(titles[0].page).toBe(1);
      expect(b.blocks.map(blockText).join(' | ')).toContain("בסוף סימן א' לעיל.");
    });

    it('starts a new part where the numbering starts over', () => {
      // Yeshuot Malko numbers 1–51, then starts again from ב (its א missing).
      const run = (from: number, to: number) =>
        Array.from({ length: to - from + 1 }, (_, k) => `שלום.|סימן|${hebrewNumber(from + k)}|ב"ה`).join('|');
      const parts = buildDoc([
        { name: 'y-001__ocr_data.html', html: spans(run(1, 7)) },
        { name: 'y-002__ocr_data.html', html: spans('כמבואר|בסוף|סימן|ב|לעיל') },
        { name: 'y-003__ocr_data.html', html: spans(run(2, 6)) },
      ]);
      expect(parts.blocks.filter((b) => b.kind === 'heading').map((b) => [b.level, blockText(b)])).toEqual([
        [2, 'חלק א'],
        ...Array.from({ length: 7 }, (_, k) => [3, `סימן ${hebrewNumber(k + 1)}`]),
        [2, 'חלק ב'],
        ...Array.from({ length: 5 }, (_, k) => [3, `סימן ${hebrewNumber(k + 2)}`]),
      ]);
    });

    it('trusts no chain too short to be a sequence', () => {
      const one = buildDoc([{ name: 'o-001__ocr_data.html', html: spans('מוחקין|אותו|סימן|ע"מ|לתקן') }]);
      expect(one.blocks.every((b) => b.kind === 'para')).toBe(true);
    });
  });

  it('uses the explicit heading class when a book provides one', () => {
    const marked = buildDoc([
      {
        name: 'y-001__ocr_data.html',
        html:
          '<span class="heading">שער</span><span> </span><span class="heading">ראשון</span>' +
          '<span> </span><span class="marked-paragraph">גוף</span><span> </span><span>הטקסט</span>',
      },
    ]);
    expect(marked.fidelity).toBe('heading');
    expect(marked.blocks[0].kind).toBe('heading');
    expect(blockText(marked.blocks[0])).toBe('שער ראשון');
    expect(marked.blocks[1].kind).toBe('para');
  });

  it('ends a bold title where the next paragraph opens in bold', () => {
    // Yaarot Devash: the sermon title runs straight into the sermon's own bold
    // opening words, and only the paragraph mark tells the two apart.
    const bold = (w: string, cls = 'bold') => `<span class="${cls}">${w}</span><span> </span>`;
    const d = buildDoc([
      {
        name: 'yd-045__ocr_data.html',
        html:
          '<span class="marked-paragraph">אמן:</span><span> </span>' +
          ['ת"מ', 'מ"ש', 'ברבים', 'הגאון', 'הנ"ל', 'בחודש', 'אלול', 'תקה"ל', 'בק"ק', 'מיץ', 'יע"א:']
            .map((w) => bold(w))
            .join('') +
          bold('המלך', 'bold marked-paragraph') +
          bold('דוד') +
          '<span>בהתפללו</span>',
      },
    ]);
    expect(d.blocks.map((b) => [b.kind, blockText(b)])).toEqual([
      ['para', 'אמן:'],
      ['heading', 'ת"מ מ"ש ברבים הגאון הנ"ל בחודש אלול תקה"ל בק"ק מיץ יע"א:'],
      ['para', 'המלך דוד בהתפללו'],
    ]);
  });

  describe('titles too long for the contents', () => {
    const bold = (w: string, cls = 'bold') => `<span class="${cls}">${w}</span><span> </span>`;
    const page = (name: string, title: string[]) => ({
      name,
      html:
        title.map((w) => bold(w)).join('') +
        '<span class="marked-paragraph">גוף</span><span> </span><span>הדרוש</span>',
    });
    const long = 'אלה הדרשות אשר דרש הגאון ז"ל בהיותו על מכון שבתו בגק"ק אה"ו ולא נאמר בו זמן מהשנה'.split(' ');

    it('numbers every section, keeping each title as its opening line', () => {
      const d = buildDoc([page('l-001__ocr_data.html', ['ת"מ', 'בק"ק', 'מיץ']), page('l-002__ocr_data.html', long)]);
      expect(d.blocks.map((b) => [b.kind, blockText(b)])).toEqual([
        ['heading', 'א'],
        ['para', 'ת"מ בק"ק מיץ'],
        ['para', 'גוף הדרוש'],
        ['heading', 'ב'],
        ['para', long.join(' ')],
        ['para', 'גוף הדרוש'],
      ]);
      expect(d.blocks[4].spans.every((s) => s.bold)).toBe(true);
    });

    it('keeps a stray long title as text rather than renumbering a well-titled book', () => {
      const short = Array.from({ length: 10 }, (_, i) =>
        page(`r-${String(i + 1).padStart(3, '0')}__ocr_data.html`, ['סימן', String(i + 1)]),
      );
      const d = buildDoc([...short, page('r-011__ocr_data.html', long)]);
      const headings = d.blocks.filter((b) => b.kind === 'heading').map(blockText);
      expect(headings).toEqual(Array.from({ length: 10 }, (_, i) => `סימן ${i + 1}`));
      expect(d.blocks.slice(-2).map((b) => [b.kind, blockText(b)])).toEqual([
        ['para', long.join(' ')],
        ['para', 'גוף הדרוש'],
      ]);
      expect(d.blocks.at(-2)!.spans.every((s) => s.bold)).toBe(true);
    });

    it('leaves short titles alone', () => {
      const d = buildDoc([page('s-001__ocr_data.html', ['סימן', 'א'])]);
      expect(d.blocks.map((b) => [b.kind, blockText(b)])).toEqual([
        ['heading', 'סימן א'],
        ['para', 'גוף הדרוש'],
      ]);
    });
  });

  it('decodes html entities', () => {
    const d = buildDoc([{ name: 'z-001__ocr_data.html', html: '<span>a&amp;b&#39;c</span>' }]);
    expect(blockText(d.blocks[0])).toBe("a&b'c");
  });

  it('survives an empty page without producing an empty block', () => {
    const d = buildDoc([
      { name: 'e-001__ocr_data.html', html: '<span> </span>' },
      { name: 'e-002__ocr_data.html', html: '<span>טקסט</span>' },
    ]);
    expect(d.blocks).toHaveLength(1);
    expect(blockText(d.blocks[0])).toBe('טקסט');
  });
});

describe('chapters', () => {
  it('opens a front-matter chapter for text before the first heading', () => {
    const chapters = chapterise(
      alfeiMenashe,
      makeDoc({
        fidelity: 'bold',
        blocks: [
          { kind: 'para', page: 1, spans: [{ text: 'הקדמה בלי כותרת', bold: false }] },
          { kind: 'heading', page: 2, spans: [{ text: 'סימן א', bold: false }] },
          { kind: 'para', page: 2, spans: [{ text: 'גוף', bold: false }] },
        ],
      }),
    );
    expect(chapters[0].title).toBe(alfeiMenashe.title);
    expect(chapters[1].title).toBe('סימן א');
  });

  it('always yields at least one chapter, even for an empty book', () => {
    const empty: BookDoc = makeDoc({ blocks: [], pageCount: 0 });
    expect(chapterise(alfeiMenashe, empty)).toHaveLength(1);
  });

  it('splits a single oversized section into numbered parts', () => {
    const long: BookDoc = makeDoc({
      blocks: Array.from({ length: 60 }, () => ({
        kind: 'para' as const,
        spans: [{ text: 'א'.repeat(5000), bold: false }],
        page: 1,
      })),
    });
    const chapters = chapterise(alfeiMenashe, long);
    expect(chapters.length).toBeGreaterThan(1);
    expect(chapters[1].title).toMatch(/\(2\)$/);
  });
});

describe('EPUB output', () => {
  const zip = epubZip;
  const read = (p: string) => zip.file(p)!.async('string');

  it('starts with an uncompressed mimetype entry', async () => {
    const names = Object.keys(zip.files);
    expect(names[0]).toBe('mimetype');
    expect(await read('mimetype')).toBe('application/epub+zip');

    // Readers identify an EPUB by reading these bytes directly, so assert on
    // the raw local file header rather than on what JSZip reports back.
    const header = builtEpub.subarray(0, 38);
    expect(Array.from(header.subarray(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const compressionMethod = header[8] | (header[9] << 8);
    expect(compressionMethod).toBe(0); // 0 = STORE
    expect(new TextDecoder().decode(header.subarray(30, 38))).toBe('mimetype');
  });

  it('points container.xml at a well-formed package document', async () => {
    const container = parseXml(await read('META-INF/container.xml'));
    const path = container
      .querySelector('rootfile')!
      .getAttribute('full-path')!;
    expect(path).toBe('OEBPS/content.opf');
    expect(zip.file(path)).not.toBeNull();
  });

  it('emits well-formed XML for every document in the package', async () => {
    const docs = Object.keys(zip.files).filter((n) => /\.(xhtml|opf|ncx|xml)$/.test(n));
    expect(docs.length).toBeGreaterThan(3);
    for (const name of docs) parseXml(await read(name));
  });

  it('declares Hebrew and right-to-left reading order', async () => {
    const opf = parseXml(await read('OEBPS/content.opf'));
    expect(opf.querySelector('language')!.textContent).toBe('he');
    expect(opf.querySelector('spine')!.getAttribute('page-progression-direction')).toBe('rtl');
    const chapter = parseXml(await read('OEBPS/ch0001.xhtml'));
    expect(chapter.documentElement.getAttribute('dir')).toBe('rtl');
  });

  it('embeds the Hebrew font rather than merely naming it', async () => {
    const font = zip.file('OEBPS/fonts/FrankRuhlLibre-hebrew.woff2');
    expect(font).not.toBeNull();
    const bytes = await font!.async('uint8array');
    // woff2 magic number.
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x77, 0x4f, 0x46, 0x32]);
    const css = await read('OEBPS/style.css');
    expect(css).toContain('@font-face');
    expect(css).toContain('fonts/FrankRuhlLibre-hebrew.woff2');
    // The OFL requires the licence to ship alongside the font.
    expect(zip.file('OEBPS/fonts/OFL.txt')).not.toBeNull();
    const opf = await read('OEBPS/content.opf');
    expect(opf).toContain('font/woff2');
  });

  it('lists every chapter in both the EPUB 3 nav and the NCX fallback', async () => {
    const chapters = Object.keys(zip.files).filter((n) => /OEBPS\/ch\d+\.xhtml$/.test(n));
    const nav = await read('OEBPS/nav.xhtml');
    const ncx = parseXml(await read('OEBPS/toc.ncx'));
    for (const c of chapters) expect(nav).toContain(c.replace('OEBPS/', ''));
    expect(ncx.querySelectorAll('navPoint')).toHaveLength(chapters.length);
  });

  it('anchors every source page so the scan stays citable', async () => {
    const nav = await read('OEBPS/nav.xhtml');
    const pageList = nav.slice(nav.indexOf('page-list'));
    for (const p of doc.blocks.map((b) => b.page)) {
      expect(pageList).toContain(`#pg${p}`);
    }
  });

  it('reproduces the source text exactly', async () => {
    const names = Object.keys(zip.files)
      .filter((n) => /OEBPS\/ch\d+\.xhtml$/.test(n))
      .sort();
    let out = '';
    for (const n of names) {
      const xhtml = await read(n);
      const body = xhtml.replace(/<span[^>]*class="pagebreak"[^>]*>.*?<\/span>/gs, '');
      out += body.replace(/<[^>]+>/g, ' ');
    }
    const decoded = out
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"');
    const source = pages.map((p) => rawText(p.html)).join('');
    expect(squash(decoded)).toContain(source.slice(0, 400));
    expect(squash(decoded).length).toBeGreaterThanOrEqual(source.length);
  });

  it('credits Dicta and states the licence on the title page', async () => {
    const title = await read('OEBPS/title.xhtml');
    expect(title).toContain('library.dicta.org.il');
    expect(title).toContain('Dicta-Library-Download');
    expect(title).toContain('creativecommons.org/licenses/by-sa/4.0');
    expect(title).toContain('דיקטה');
    expect(title).toContain('OCR');
  });

  it('carries the book metadata', async () => {
    const opf = parseXml(await read('OEBPS/content.opf'));
    expect(opf.querySelector('title')!.textContent).toBe(alfeiMenashe.title);
    expect(opf.querySelector('creator')!.textContent).toBe(alfeiMenashe.author);
    expect(opf.querySelector('date')!.textContent).toBe('1880');
  });

  it('escapes markup characters in metadata', async () => {
    const risky = { ...alfeiMenashe, title: 'ספר <b>&"נסיון"' };
    const out = await buildEpub(risky, doc);
    const z = await JSZip.loadAsync(out);
    parseXml(await z.file('OEBPS/content.opf')!.async('string'));
    parseXml(await z.file('OEBPS/title.xhtml')!.async('string'));
  });
});

describe('DOCX output', () => {
  it('produces a Word package with right-to-left paragraphs', async () => {
    const bytes = await buildDocx(alfeiMenashe, doc);
    const zip = await JSZip.loadAsync(bytes);
    expect(zip.file('word/document.xml')).not.toBeNull();

    const xml = await zip.file('word/document.xml')!.async('string');
    parseXml(xml);
    // Paragraph-level bidi and run-level rtl are both required or Word lays
    // the Hebrew out left-to-right.
    expect(xml).toContain('<w:bidi');
    expect(xml).toContain('<w:rtl');
    // Hebrew needs the complex-script font slot, not just ascii.
    expect(xml).toContain('w:cs="FrankRuehl"');
    expect(xml).toContain('דיקטה');
  });
});

describe('table of contents', () => {
  it('lists each detected heading with its printed folio', () => {
    const entries = tocEntries(doc);
    expect(entries.length).toBeGreaterThanOrEqual(3);
    for (const e of entries) {
      expect(e.text.trim()).not.toBe('');
      expect(e.page).toBeGreaterThan(0);
    }
    expect(entries.map((e) => e.text)).toContain('ענין הטבעים ב');
    // Folios must ascend: a contents page that jumps around is a parser bug.
    const folios = entries.map((e) => e.page);
    expect(folios).toEqual([...folios].sort((a, b) => a - b));
  });

  it('omits the contents page when there is nothing to navigate', () => {
    expect(shouldIncludeToc([])).toBe(false);
    expect(shouldIncludeToc(tocEntries(doc))).toBe(true);
  });

  it('adds a visible contents page to the EPUB spine', async () => {
    const opf = await epubZip.file('OEBPS/content.opf')!.async('string');
    expect(opf).toContain('href="contents.xhtml"');
    expect(opf).toContain('<itemref idref="contents"/>');
    const contents = await epubZip.file('OEBPS/contents.xhtml')!.async('string');
    expect(contents).toContain('תוכן העניינים');
    expect(contents).toContain('ענין הטבעים ב');
  });

  it('points every contents link at an anchor that exists', async () => {
    const contents = await epubZip.file('OEBPS/contents.xhtml')!.async('string');
    const links = [...contents.matchAll(/href="([^"]+\.xhtml)#([^"]+)"/g)];
    expect(links.length).toBeGreaterThan(0);

    for (const [, file, anchor] of links) {
      const target = epubZip.file(`OEBPS/${file}`);
      expect(target, `missing target file ${file}`).not.toBeNull();
      expect(await target!.async('string')).toContain(`id="${anchor}"`);
    }
  });

  it('writes a contents page into the Word document too', async () => {
    const bytes = await buildDocx(alfeiMenashe, doc);
    const zip = await JSZip.loadAsync(bytes);
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(xml).toContain('תוכן העניינים');
    expect(xml).toContain('ענין הטבעים ב');
  });
});

describe('DOCX presentation', () => {
  const built = buildDocx(alfeiMenashe, doc);

  it('sets headings in black serif, not the blue Word heading style', async () => {
    const zip = await JSZip.loadAsync(await built);
    const styles = await zip.file('word/styles.xml')!.async('string');
    expect(styles).toContain('SectionHeading');
    // Word's stock heading blues would make this read like an office memo.
    for (const blue of ['2F5496', '4472C4', '365F91', '1F4E79']) {
      expect(styles).not.toContain(blue);
    }
    const heading = /w:styleId="SectionHeading"[\s\S]*?<\/w:style>/.exec(styles);
    expect(heading).not.toBeNull();
    expect(heading![0]).toContain('FrankRuehl');
    expect(heading![0]).toContain('w:val="000000"');
  });

  it('gives the document a running head and page numbers', async () => {
    const zip = await JSZip.loadAsync(await built);
    const header = await zip.file('word/header1.xml')!.async('string');
    const footer = await zip.file('word/footer1.xml')!.async('string');
    expect(header).toContain(alfeiMenashe.title);
    // A PAGE field, so Word numbers the pages itself.
    expect(footer).toContain('PAGE');
    expect(footer).toContain('fldChar');
  });

  it('floats the scanned folio into the outer margin', async () => {
    const zip = await JSZip.loadAsync(await built);
    const xml = await zip.file('word/document.xml')!.async('string');

    // Word's mechanism for a marginal note: a framed paragraph anchored to the
    // page horizontally and to the text vertically, so it travels with its
    // paragraph however Word repaginates.
    const frames = xml.match(/<w:framePr[^>]*\/>/g) ?? [];
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0]).toContain('w:hAnchor="page"');
    expect(frames[0]).toContain('w:vAnchor="text"');

    // One marker per distinct scanned folio, not one per paragraph.
    const folios = new Set(doc.blocks.map((b) => b.page));
    expect(frames).toHaveLength(folios.size);
  });

  it('indents paragraphs and justifies them like a printed book', async () => {
    const zip = await JSZip.loadAsync(await built);
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(xml).toContain('w:firstLine');
    expect(xml).toContain('w:val="both"');
  });
});

describe('te\u2019amim in the exports', () => {
  // Song of Songs 1:3, accented — the verse the old stripping turned into
  // `לְרֵ □יחַ □שְׁמָנֶ □יךָ` and so was deleted outright.
  const VERSE = 'לְרֵ֙יחַ֙ שְׁמָנֶ֣יךָ טוֹבִ֔ים';
  const accented = makeDoc({
    blocks: [{ kind: 'para', page: 1, spans: [{ text: VERSE, bold: false }] }],
  });
  const plainDoc = makeDoc({
    blocks: [{ kind: 'para', page: 1, spans: [{ text: 'דין השכמת הבוקר', bold: false }] }],
  });
  const TAAM = /[\u0591-\u05AF]/;

  it('keeps the accents in an EPUB, and embeds a face that can set them', async () => {
    const zip = await JSZip.loadAsync(await buildEpub(alfeiMenashe, accented));
    const chapter = await zip.file('OEBPS/ch0001.xhtml')!.async('string');
    expect(TAAM.test(chapter)).toBe(true);
    expect(zip.file('OEBPS/fonts/TaameyD-hebrew.woff2')).not.toBeNull();
    const css = await zip.file('OEBPS/style.css')!.async('string');
    expect(css).toContain('Taamey D');
  });

  it('leaves an unaccented book on the face it always used', async () => {
    const zip = await JSZip.loadAsync(await buildEpub(alfeiMenashe, plainDoc));
    expect(zip.file('OEBPS/fonts/FrankRuhlLibre-hebrew.woff2')).not.toBeNull();
    expect(zip.file('OEBPS/fonts/TaameyD-hebrew.woff2')).toBeNull();
  });

  it('carries the licence of whichever face travelled', async () => {
    const zip = await JSZip.loadAsync(await buildEpub(alfeiMenashe, accented));
    const licence = await zip.file('OEBPS/fonts/LICENSE-TaameyD.txt')!.async('string');
    expect(licence).toContain('Taamey D');
  });

  it('keeps the accents in a DOCX, which asks for a font that has them', async () => {
    const zip = await JSZip.loadAsync(await buildDocx(alfeiMenashe, accented));
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(TAAM.test(xml)).toBe(true);
  });
});

describe('citations in the exports', () => {
  // A commentary as Sefaria files it: a verse, then remarks hanging off it.
  const cited = makeDoc({
    blocks: [
      { kind: 'heading', page: 1, spans: [{ text: 'פרק ח', bold: false }], level: 3 },
      { kind: 'para', page: 2, label: 'ח:יג', spans: [{ text: 'הַיּוֹשֶׁבֶת בַּגַּנִּים', bold: false }] },
      { kind: 'para', page: 3, label: 'ח:יג:א', layer: 'מלבי״ם', spans: [{ text: 'משל דברי המפרש', bold: false }] },
      { kind: 'para', page: 4, label: 'ח:יג:ב', layer: 'מלבי״ם', spans: [{ text: 'מליצה דברי המפרש', bold: false }] },
    ],
  });

  it('sets the verse number inline in an EPUB, and drops the margin citation', async () => {
    const zip = await JSZip.loadAsync(await buildEpub(alfeiMenashe, cited));
    const chapter = await zip.file('OEBPS/ch0001.xhtml')!.async('string');
    expect(chapter).toContain('<span class="verse">יג</span>');
    // The full citation used to be printed beside every remark.
    expect(chapter).not.toContain('ח:יג:ב');
    expect(chapter).not.toContain('doc-pagebreak');
  });

  it('leaves a Dicta book its folio marks, which are not citations', async () => {
    const zip = await JSZip.loadAsync(await buildEpub(alfeiMenashe, doc));
    const chapter = await zip.file('OEBPS/ch0001.xhtml')!.async('string');
    expect(chapter).toContain('doc-pagebreak');
    expect(chapter).not.toContain('class="verse"');
  });

  it('sets the verse number inline in a DOCX, and not the commentary numbers', async () => {
    const zip = await JSZip.loadAsync(await buildDocx(alfeiMenashe, cited));
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(xml).toContain('יג');
    expect(xml).not.toContain('ח:יג:ב');
  });
});

describe('embedding the cantillation font in a DOCX', () => {
  const ttf = new Uint8Array(readFileSync(resolve('src/assets/fonts/TaameyD.ttf')));
  const accented = makeDoc({
    blocks: [{ kind: 'para', page: 1, spans: [{ text: 'לְרֵ֙יחַ֙ שְׁמָנֶ֣יךָ', bold: false }] }],
  });
  const plainDoc = makeDoc({
    blocks: [{ kind: 'para', page: 1, spans: [{ text: 'דין השכמת הבוקר', bold: false }] }],
  });

  it('carries the font inside the file, declared the way Word expects', async () => {
    const zip = await JSZip.loadAsync(await buildDocx(alfeiMenashe, accented, ttf));
    expect(zip.file('word/fonts/font1.odttf')).not.toBeNull();

    const types = await zip.file('[Content_Types].xml')!.async('string');
    expect(types).toContain('obfuscatedFont');

    const settings = await zip.file('word/settings.xml')!.async('string');
    expect(settings).toContain('<w:embedTrueTypeFonts/>');

    const table = await zip.file('word/fontTable.xml')!.async('string');
    expect(table).toContain('w:name="Taamey D"');
    expect(table).toContain('w:embedRegular');

    const rels = await zip.file('word/_rels/fontTable.xml.rels')!.async('string');
    expect(rels).toContain('fonts/font1.odttf');
  });

  it('sets the text in the embedded family, not the installed one', async () => {
    const zip = await JSZip.loadAsync(await buildDocx(alfeiMenashe, accented, ttf));
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(xml).toContain('w:cs="Taamey D"');
    expect(xml).not.toContain('FrankRuehl');
  });

  it('scrambles only the first 32 bytes, and reversibly', async () => {
    const zip = await JSZip.loadAsync(await buildDocx(alfeiMenashe, accented, ttf));
    const stored = await zip.file('word/fonts/font1.odttf')!.async('uint8array');
    expect(stored.length).toBe(ttf.length);
    // Obfuscation is its own inverse, so a second pass gives the font back.
    expect(Array.from(obfuscate(stored).slice(0, 64))).toEqual(Array.from(ttf.slice(0, 64)));
  });

  it('embeds nothing in a book with no te\u2019amim', async () => {
    const zip = await JSZip.loadAsync(await buildDocx(alfeiMenashe, plainDoc, ttf));
    expect(zip.file('word/fonts/font1.odttf')).toBeNull();
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(xml).toContain('FrankRuehl');
  });
});
