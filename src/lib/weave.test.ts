import { weaveCommentary } from './weave';
import { describe, expect, it } from 'vitest';
import { buildSefariaDoc } from './sefariaDoc';
import { combinedLicense, licenseFor, sefariaAttribution } from './attribution';
import { hasUnsupportedMarks, stripUnsupportedMarks } from './hebrew';
import { blockText } from './parseOcr';
import { blockLabel } from './types';
import { tocEntries } from './toc';

const at = (license: string) => sefariaAttribution({ versionTitle: 'ed.', license });

/** Two chapters of two verses. */
const base = buildSefariaDoc(
  [
    {
      sectionNames: ['Chapter', 'Verse'],
      addressTypes: ['Perek', 'Pasuk'],
      text: [
        ['פסוק ראשון', 'פסוק שני'],
        ['פסוק שלישי', 'פסוק רביעי'],
      ],
    },
  ],
  at('Public Domain'),
);

/** A commentary on it: base structure plus one level. */
const commentary = buildSefariaDoc(
  [
    {
      sectionNames: ['Chapter', 'Verse', 'Comment'],
      addressTypes: ['Perek', 'Pasuk', 'Integer'],
      text: [
        [['על הראשון א', 'על הראשון ב'], ['על השני']],
        [[], ['על הרביעי']],
      ],
    },
  ],
  at('CC-BY'),
);

describe('weaving a commentary into its base text', () => {
  const blocks = weaveCommentary(base, commentary);
  const paras = blocks.filter((b) => b.kind === 'para');

  it('keeps every verse and every comment', () => {
    expect(paras.filter((b) => !b.layer)).toHaveLength(4);
    expect(paras.filter((b) => b.layer)).toHaveLength(4);
  });

  // A comment labelled א:א:ב belongs under the verse labelled א:א — the
  // citation label is the join, with no need for base_text_mapping.
  it('puts each comment directly under the verse it is on', () => {
    const order = paras.map((b) => `${b.layer ? '  ' : ''}${blockLabel(b)}`);
    expect(order).toEqual([
      'א:א',
      '  א:א:א',
      '  א:א:ב',
      'א:ב',
      '  א:ב:א',
      'ב:א',
      'ב:ב',
      '  ב:ב:א',
    ]);
  });

  it('leaves a verse with no comment on it alone', () => {
    const at21 = paras.findIndex((b) => blockLabel(b) === 'ב:א');
    expect(paras[at21].layer).toBeUndefined();
    expect(paras[at21 + 1].layer).toBeUndefined();
  });

  it('marks commentary with the source it came from', () => {
    for (const b of paras.filter((b) => b.layer)) expect(b.layer).toBe('ספריא');
  });

  // The base text's headings structure the book; the commentary's own chapter
  // headings would only duplicate them.
  it('takes its chapters from the base text', () => {
    expect(tocEntries({ ...base, blocks }).map((e) => e.text)).toEqual(['פרק א', 'פרק ב']);
  });

  it('reads as verse then commentary', () => {
    expect(paras.slice(0, 3).map(blockText)).toEqual([
      'פסוק ראשון',
      'על הראשון א',
      'על הראשון ב',
    ]);
  });
});

describe('a comment with nothing to attach to', () => {
  // Editions differ; a commentary may cover a verse the base edition we loaded
  // does not carry. Losing the commentator's words silently is the worst
  // possible outcome.
  it('keeps an orphaned comment rather than dropping it', () => {
    const orphaned = buildSefariaDoc(
      [
        {
          sectionNames: ['Chapter', 'Verse', 'Comment'],
          addressTypes: ['Perek', 'Pasuk', 'Integer'],
          text: [[], [], [[], [], ['על פרק שלא קיים']]],
        },
      ],
      at('Public Domain'),
    );
    const blocks = weaveCommentary(base, orphaned);
    const kept = blocks.find((b) => blockText(b) === 'על פרק שלא קיים');
    expect(kept).toBeDefined();
    expect(kept?.layer).toBe('ספריא');
  });
});

describe('a book built from two differently licensed sources', () => {
  it('reports both licences', () => {
    const both = combinedLicense([at('Public Domain'), at('CC-BY-SA')]);
    expect(both.name).toContain('נחלת הכלל');
    expect(both.name).toContain('Creative Commons BY-SA 4.0');
    expect(both.exportable).toBe(true);
  });

  it('does not repeat a licence both sources share', () => {
    expect(combinedLicense([at('CC-BY'), at('CC-BY')]).name).toBe(
      licenseFor('CC-BY').name,
    );
  });

  // The base text being freely licensed does not free the commentary, nor the
  // other way round: one restricted part restricts the whole file.
  it('refuses the export if either source refuses it', () => {
    expect(combinedLicense([at('Public Domain'), at('Copyright: Schocken')]).exportable).toBe(
      false,
    );
    expect(combinedLicense([at('Copyright: Schocken'), at('Public Domain')]).exportable).toBe(
      false,
    );
  });
});

describe('cantillation the export font cannot set', () => {
  // Frank Ruhl Libre has all 31 vowels and none of the 31 accents, so a ta'am
  // reaches a PDF as a box. Removing them keeps the vocalisation and loses
  // only the chant.
  it('removes the accents and keeps the vowels', () => {
    const verse = 'לְרֵ֨יחַ֙ שְׁמָנֶ֣יךָ טוֹבִ֔ים';
    const out = stripUnsupportedMarks(verse);
    expect(hasUnsupportedMarks(verse)).toBe(true);
    expect(hasUnsupportedMarks(out)).toBe(false);
    expect(out).toBe('לְרֵיחַ שְׁמָנֶיךָ טוֹבִים');
  });

  it('leaves unvocalised text alone', () => {
    expect(stripUnsupportedMarks('דין השכמת הבוקר')).toBe('דין השכמת הבוקר');
  });

  it('keeps punctuation and the meteg, which the font does have', () => {
    const out = stripUnsupportedMarks('עַל־כֵּ֥ן עֲלָמ֥וֹת אֲהֵבֽוּךָ׃');
    expect(out).toContain('־'); // maqaf
    expect(out).toContain('׃'); // sof pasuq
    expect(out).toContain('ֽ'); // meteg, U+05BD — present in the font
  });

  it('removes the three rare marks the font also lacks', () => {
    expect(stripUnsupportedMarks('אׄבׅג׆')).toBe('אבג');
  });
});
