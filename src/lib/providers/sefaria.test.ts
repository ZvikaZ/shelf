import { afterEach, describe, expect, it, vi } from 'vitest';
import { leafRefs } from './sefaria';

afterEach(() => vi.unstubAllGlobals());

describe('leafRefs', () => {
  it('names a default child after its parent, and leaves it out of the ref', async () => {
    // Beit Elohim's Introduction: a branch titled only by a shared term, whose
    // main text sits in a nameless `default` child beside a titled sibling.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ titles: [{ lang: 'he', text: 'הקדמה', primary: true }] }),
      })),
    );
    const schema = {
      key: 'Beit Elohim',
      titles: [{ lang: 'en', text: 'Beit Elohim', primary: true }],
      nodes: [
        {
          key: 'Introduction',
          sharedTitle: 'Introduction',
          nodes: [
            { key: 'default', default: true },
            {
              key: 'Table of Contents',
              titles: [
                { lang: 'en', text: 'Table of Contents', primary: true },
                { lang: 'he', text: 'מפתחות', primary: true },
              ],
            },
          ],
        },
      ],
    };

    expect(await leafRefs(schema)).toEqual([
      { ref: 'Beit Elohim, Introduction', heTitle: 'הקדמה' },
      { ref: 'Beit Elohim, Introduction, Table of Contents', heTitle: 'מפתחות' },
    ]);
  });
});
