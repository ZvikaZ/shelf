import { describe, expect, it, vi } from 'vitest';
import { makeBook, makeDoc } from '../test/fixtures';
import { DICTA_ATTRIBUTION, licenseFor } from './attribution';

const getDoc = vi.hoisted(() => vi.fn());
vi.mock('./bookCache', () => ({ getDoc, cached: () => undefined }));

const { exportBook } = await import('./exporter');

const book = makeBook({ id: 'sefaria:guarded' });

describe('licence gating', () => {
  it('refuses to build a file from an edition that names a rights holder', async () => {
    // Sefaria carries editions still under copyright. The reader disables the
    // menu and the static export skips them, but the rule is enforced here so
    // a new caller cannot route around it.
    getDoc.mockResolvedValue(
      makeDoc({
        blocks: [{ kind: 'para', page: 1, spans: [{ text: 'טקסט', bold: false }] }],
        attribution: {
          ...DICTA_ATTRIBUTION,
          license: licenseFor('Copyright: The Estate of Somebody'),
        },
      }),
    );

    await expect(exportBook(book, 'epub')).rejects.toThrow(/זכויות יוצרים/);
  });

  it('recognises a rights holder however the licence is written', () => {
    expect(licenseFor('Copyright: X').exportable).toBe(false);
    expect(licenseFor('copyright 2020 someone').exportable).toBe(false);
    // Everything Sefaria marks as free, and its undocumented case, stays open.
    for (const ok of ['Public Domain', 'PD', 'CC0', 'CC-BY', 'CC-BY-SA', '', 'unknown']) {
      expect(licenseFor(ok).exportable).toBe(true);
    }
  });
});
