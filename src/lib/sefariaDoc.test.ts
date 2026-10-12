import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildSefariaDoc,
  HE_SECTION,
  hebrewNumber,
  spansFromHtml,
  talmudAddress,
  type TextNode,
} from './sefariaDoc';
import { blockText } from './parseOcr';
import { blockLabel } from './types';
import { sefariaAttribution } from './attribution';
import { tocEntries } from './toc';

/** Real API responses, captured from www.sefaria.org. */
function fixture(name: string) {
  return JSON.parse(readFileSync(resolve(`src/test/fixtures/${name}.json`), 'utf8'));
}

function nodeFrom(name: string): TextNode {
  const res = fixture(name);
  return {
    sectionNames: res.sectionNames,
    addressTypes: res.addressTypes,
    text: res.versions[0].text,
  };
}

describe('Hebrew numbering', () => {
  it('numbers with letters, not digits', () => {
    expect(hebrewNumber(1)).toBe('א');
    expect(hebrewNumber(9)).toBe('ט');
    expect(hebrewNumber(10)).toBe('י');
    expect(hebrewNumber(21)).toBe('כא');
    expect(hebrewNumber(100)).toBe('ק');
    expect(hebrewNumber(248)).toBe('רמח');
  });

  it('never spells the Name for 15 and 16', () => {
    expect(hebrewNumber(15)).toBe('טו');
    expect(hebrewNumber(16)).toBe('טז');
    expect(hebrewNumber(115)).toBe('קטו');
  });

  it('writes a daf as amud alef then bet', () => {
    expect(talmudAddress(2)).toBe('ב ע"א');
    expect(talmudAddress(3)).toBe('ב ע"ב');
    expect(talmudAddress(8)).toBe('ה ע"א');
  });
});

describe('inline markup', () => {
  it('keeps bold and drops the rest', () => {
    const { spans } = spansFromHtml('<b>כותרת</b> ואז טקסט <big>רגיל</big>');
    expect(spans).toEqual([
      { text: 'כותרת', bold: true },
      { text: 'ואז טקסט רגיל', bold: false },
    ]);
  });

  it('drops commentator anchors, which carry no words', () => {
    const html =
      '<i data-commentator="Turei Zahav" data-order="1"></i>יתגבר ' +
      '<i data-commentator="Ba\'er Hetev" data-order="1"></i>כארי';
    expect(blockText({ kind: 'para', page: 1, spans: spansFromHtml(html).spans })).toBe(
      'יתגבר כארי',
    );
  });

  it('drops footnote markers and their bodies', () => {
    const html = 'בראשית<sup class="footnote-marker">1</sup><i class="footnote">הערה</i> ברא';
    expect(blockText({ kind: 'para', page: 1, spans: spansFromHtml(html).spans })).toBe(
      'בראשית ברא',
    );
  });

  it('decodes entities', () => {
    expect(spansFromHtml('&quot;שלום&quot; &amp; עוד').spans[0].text).toBe('"שלום" & עוד');
  });

  it('breaks a paragraph at <br>, which these books use for one', () => {
    const { breaks } = spansFromHtml('שורה ראשונה<br>שורה שנייה');
    expect(breaks).toHaveLength(1);
  });

  // Everything downstream rejoins spans with a space, so a span may only ever
  // end where the source had whitespace.
  it('does not invent a space where a tag splits a word', () => {
    const { spans } = spansFromHtml('<big>בְּ</big>רֵאשִׁית בָּרָא');
    expect(spans).toHaveLength(1);
    expect(spans[0].text).toBe('בְּרֵאשִׁית בָּרָא');
  });

  it('absorbs emphasis that changes mid-word, rather than breaking the word', () => {
    const { spans } = spansFromHtml('<b>ד</b>ין השכמת הבוקר');
    expect(spans.map((s) => s.text).join(' ')).toBe('דין השכמת הבוקר');
  });

  it('still splits emphasis that changes at a space', () => {
    const { spans } = spansFromHtml('<b>דין השכמת הבוקר</b> יתגבר כארי');
    expect(spans).toEqual([
      { text: 'דין השכמת הבוקר', bold: true },
      { text: 'יתגבר כארי', bold: false },
    ]);
  });
});

describe('a simple book', () => {
  const doc = buildSefariaDoc([nodeFrom('sefaria-simple')], sefariaAttribution({ versionTitle: 'מהדורת בדיקה' }));

  it('produces text', () => {
    expect(doc.blocks.length).toBeGreaterThan(0);
    expect(doc.blocks.every((b) => blockText(b).trim().length > 0)).toBe(true);
  });

  it('loses no HTML into the output', () => {
    for (const b of doc.blocks) expect(blockText(b)).not.toMatch(/<[a-z/]/i);
  });

  it('reports explicit structure rather than inferring it', () => {
    expect(doc.fidelity).toBe('heading');
  });

  it('carries no folio word, because a reference names its own units', () => {
    expect(doc.citation).toBeUndefined();
  });

  it('labels every block with a Hebrew citation', () => {
    for (const b of doc.blocks) expect(blockLabel(b)).toMatch(/[֐-׿]/);
  });
});

describe('a vocalised Tanakh book', () => {
  const doc = buildSefariaDoc(
    [nodeFrom('sefaria-tanakh')],
    sefariaAttribution({ versionTitle: 'Miqra according to the Masorah' }),
  );
  const text = doc.blocks.map(blockText);

  // Sefaria sets a thin space either side of a paseq and pads verse ends with
  // non-breaking ones; an entity the decoder does not know renders literally.
  it('decodes every entity, leaving none as literal text', () => {
    for (const t of text) expect(t).not.toMatch(/&[a-zA-Z#0-9]+;/);
  });

  // {פ} and {ס} mark a section break in a scroll. They are real notation, but
  // stripped of the styling that sets them apart they read as debris.
  it('drops the Masoretic section markers', () => {
    for (const t of text) expect(t).not.toMatch(/\{[ספ]\}/);
  });

  it('keeps ketiv and qere, which a printed Tanakh shows both of', () => {
    const kq = text.find((t) => t.includes('רַהִיטֵ֖נוּ'));
    expect(kq).toContain('(רחיטנו)');
    expect(kq).toContain('[רַהִיטֵ֖נוּ]');
  });

  // Song of Songs 8:4, which is where the raw entities were first spotted: it
  // carries a paseq set off by thin spaces and a trailing section marker.
  it('renders a verse with a paseq as plain spaced text', () => {
    const verse = doc.blocks.find((b) => blockLabel(b) === 'ח:ד');
    expect(verse).toBeDefined();
    const t = blockText(verse!);

    expect(t).toContain(' ׀ '); // the thin spaces became ordinary ones
    expect(t).not.toMatch(/&|[{}]|\s{2,}/); // no entity, marker or padding left
    expect(t.endsWith('׃')).toBe(true); // the sof pasuq is the last thing on it
    expect(t).toMatch(/[֑-֯]/); // cantillation survived
    expect(t).toMatch(/[ְ-ּ]/); // and so did the vowels
  });
});

describe('a depth-3 book', () => {
  const node = nodeFrom('sefaria-depth3');
  const doc = buildSefariaDoc([node], sefariaAttribution({ versionTitle: 'מהדורת בדיקה' }));

  it('is genuinely three levels deep', () => {
    expect(node.sectionNames).toHaveLength(3);
  });

  it('flattens without assuming a depth', () => {
    expect(doc.blocks.length).toBeGreaterThan(10);
  });

  it('cites all three levels, innermost last', () => {
    const para = doc.blocks.find((b) => b.kind === 'para' && (b.label?.split(':').length ?? 0) === 3);
    expect(para).toBeDefined();
  });

  it('numbers headings from the outermost level only', () => {
    const headings = doc.blocks.filter((b) => b.kind === 'heading');
    expect(headings.length).toBeGreaterThan(0);
    for (const h of headings) expect(h.label).not.toContain(':');
  });
});

describe('a complex book', () => {
  // The schema of Pesach Haggadah: a tree whose leaves are the fetchable refs.
  const schema = fixture('sefaria-complex-index').schema;

  it('is a tree of named nodes, not a jagged array', () => {
    expect(schema.nodes.length).toBeGreaterThan(0);
    expect(schema.depth).toBeUndefined();
  });

  it('takes each node title as a heading', () => {
    const nodes: TextNode[] = [
      { heTitle: 'קדש', sectionNames: ['Paragraph'], addressTypes: ['Integer'], text: ['ברוך'] },
      { heTitle: 'ורחץ', sectionNames: ['Paragraph'], addressTypes: ['Integer'], text: ['נוטלין'] },
    ];
    const doc = buildSefariaDoc(nodes, sefariaAttribution({ versionTitle: 'מהדורת בדיקה' }));
    expect(doc.blocks.filter((b) => b.kind === 'heading').map((b) => blockText(b))).toEqual([
      'קדש',
      'ורחץ',
    ]);
    expect(tocEntries(doc).map((e) => e.text)).toEqual(['קדש', 'ורחץ']);
  });

  // The outermost level of a named node is its paragraphs, not its sections;
  // numbering them buries the real headings under a "פסקה N" for every line.
  it('does not number the paragraphs inside an already-named section', () => {
    const doc = buildSefariaDoc([
      {
        heTitle: 'קדש',
        sectionNames: ['Paragraph'],
        addressTypes: ['Integer'],
        text: ['מוזגים כוס ראשון', 'ברוך אתה', 'שהחיינו'],
      },
    ], sefariaAttribution({ versionTitle: 'מהדורת בדיקה' }));
    expect(doc.blocks.filter((b) => b.kind === 'heading')).toHaveLength(1);
    expect(doc.blocks.filter((b) => b.kind === 'para')).toHaveLength(3);
  });

  it('still numbers the chapters of a book that has no node title', () => {
    const doc = buildSefariaDoc([
      {
        sectionNames: ['Chapter'],
        addressTypes: ['Integer'],
        text: ['פרק ראשון', 'פרק שני'],
      },
    ], sefariaAttribution({ versionTitle: 'מהדורת בדיקה' }));
    expect(doc.blocks.filter((b) => b.kind === 'heading').map((b) => blockText(b))).toEqual([
      'פרק א',
      'פרק ב',
    ]);
  });
});

describe('a book in several parts', () => {
  // Responsa Chatam Sofer: each part numbers its own responsa from א, and
  // Even HaEzer adds a level — חלק, then תשובה, then the paragraphs.
  const names = { ...HE_SECTION, Teshuva: 'תשובה' };
  const doc = buildSefariaDoc(
    [
      {
        heTitle: 'אורח חיים',
        sectionNames: ['Teshuva', 'Paragraph'],
        addressTypes: ['Integer', 'Integer'],
        text: [['א1'], ['ב1']],
      },
      {
        heTitle: 'אבן העזר',
        sectionNames: ['Section', 'Teshuva', 'Paragraph'],
        addressTypes: ['Integer', 'Integer', 'Integer'],
        text: [[['א1', 'א2'], ['ב1']], [['ג1'], ['ד1']]],
      },
    ],
    sefariaAttribution({}),
    names,
  );
  const headings = doc.blocks
    .filter((b) => b.kind === 'heading')
    .map((b) => [b.level, blockText(b)]);

  it('nests each part, and every responsum under it, a level deeper', () => {
    expect(headings).toEqual([
      [2, 'אורח חיים'],
      [3, 'תשובה א'],
      [3, 'תשובה ב'],
      [2, 'אבן העזר'],
      [3, 'חלק א'],
      [4, 'תשובה א'],
      [4, 'תשובה ב'],
      [3, 'חלק ב'],
      [4, 'תשובה א'],
      [4, 'תשובה ב'],
    ]);
  });

  it('still heads only the outermost level where the innermost is not paragraphs', () => {
    const talmud = buildSefariaDoc([nodeFrom('sefaria-depth3')], sefariaAttribution({}));
    expect(talmud.blocks.filter((b) => b.kind === 'heading').every((b) => b.level === 3)).toBe(true);
  });
});

describe('gaps in a version', () => {
  it('skips sections the edition has no text for', () => {
    const node: TextNode = {
      sectionNames: ['Chapter', 'Verse'],
      addressTypes: ['Integer', 'Integer'],
      text: [[''], ['יש כאן טקסט'], []],
    };
    const doc = buildSefariaDoc([node], sefariaAttribution({ versionTitle: 'מהדורת בדיקה' }));
    expect(doc.blocks.filter((b) => b.kind === 'para')).toHaveLength(1);
    // The one chapter with text is chapter 2, and says so.
    expect(doc.blocks.find((b) => b.kind === 'heading')?.label).toBe('ב');
  });
});

// A blanket guard: any markup the parser learns to mishandle shows up here
// before it reaches a reader.
describe('no markup survives into the text, in any fixture', () => {
  for (const name of ['sefaria-simple', 'sefaria-depth3', 'sefaria-tanakh']) {
    it(name, () => {
      const doc = buildSefariaDoc([nodeFrom(name)], sefariaAttribution({}));
      for (const b of doc.blocks) {
        const t = blockText(b);
        expect(t).not.toMatch(/<[a-z/]/i);
        expect(t).not.toMatch(/&[a-zA-Z#0-9]+;/);
      }
    });
  }
});

describe('a section name with stray punctuation', () => {
  // BePardes HaChasidut VeHakabbalah names one section's levels `[Chapter`.
  const doc = buildSefariaDoc(
    [
      {
        heTitle: 'יסודות החסידות',
        sectionNames: ['[Chapter', 'Paragraph'],
        addressTypes: ['Integer', 'Integer'],
        text: [['א'], ['ב']],
      },
    ],
    sefariaAttribution({}),
  );

  it('still reads it as the name it means', () => {
    const headings = doc.blocks.filter((b) => b.kind === 'heading').map(blockText);
    expect(headings).toContain('פרק א');
    expect(headings.join(' ')).not.toMatch(/Chapter/);
  });
});
