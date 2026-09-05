import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { makeBook, makeDoc } from './test/fixtures';
import type { Catalogue } from './lib/types';

const exportBook = vi.hoisted(() => vi.fn());
// BookDetail loads this module lazily on the first download; the labels it
// paints with come from ./lib/formats, which stays real.
vi.mock('./lib/exporter', () => ({ exportBook }));

const getDoc = vi.hoisted(() => vi.fn());
vi.mock('./lib/bookCache', () => ({ getDoc, cached: () => undefined }));

const books = [
  makeBook({
    id: 'alfeimenashe',
    title: 'אלפי מנשה חלק א',
    author: 'מנשה בן פורת',
    category: 'מחשבה ומוסר',
    subcategory: 'מחשבה (אחרונים)',
    year: 1880,
    key: 'אלפי מנשה חלק א מנשה בן פורת',
  }),
  makeBook({
    id: 'alfeimenashetorah',
    // The gershayim here is the U+05F4 character, not a plain quote.
    title: 'אלפי מנשה עה״ת',
    author: 'מנשה איכנשטין',
    category: 'חסידות',
    subcategory: 'ת"ר - ת"ש',
    year: 1935,
    key: 'אלפי מנשה עהת מנשה איכנשטין',
  }),
  makeBook({
    id: 'achiezer',
    title: 'אחיעזר אבן העזר',
    author: 'חיים עוזר גרודזינסקי',
    category: 'שאלות ותשובות (שו"ת)',
    subcategory: 'אחרונים - מערב',
    year: 1922,
    key: 'אחיעזר אבן העזר חיים עוזר גרודזינסקי',
  }),
];

const catalogue: Catalogue = {
  facets: {
    categories: [
      { name: 'שאלות ותשובות (שו"ת)', count: 1 },
      { name: 'מחשבה ומוסר', count: 1 },
      { name: 'חסידות', count: 1 },
    ],
    subcategories: [
      { name: 'מחשבה (אחרונים)', count: 1 },
      { name: 'ת"ר - ת"ש', count: 1 },
      { name: 'אחרונים - מערב', count: 1 },
    ],
    total: 3,
    fetchedAt: '2026-08-27',
  },
  books,
};

/** A library with no books, so a test can ignore the half it is not about. */
const empty: Catalogue = {
  facets: { categories: [], subcategories: [], total: 0, fetchedAt: '2026-08-27' },
  books: [],
};

/**
 * The app loads one catalogue file per library and merges them, so the stub has
 * to answer per URL rather than return one payload to every call.
 */
function mockCatalogue(payload: unknown = catalogue, ok = true, sefaria: unknown = empty) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      Promise.resolve({
        ok,
        status: ok ? 200 : 404,
        json: () => Promise.resolve(String(url).includes('sefaria') ? sefaria : payload),
      }),
    ),
  );
}

beforeEach(() => {
  getDoc.mockReset();
  getDoc.mockResolvedValue(
    makeDoc({
      fidelity: 'bold',
      blocks: [{ kind: 'para', page: 2, spans: [{ text: 'פתח דבר לספר', bold: false }] }],
    }),
  );
  exportBook.mockReset();
  exportBook.mockResolvedValue(undefined);
  window.history.replaceState(null, '', '/');
  mockCatalogue();
});

afterEach(() => vi.unstubAllGlobals());

/** Wait for the catalogue fetch to settle and the list to render. */
async function renderApp() {
  render(<App />);
  await screen.findByText('אלפי מנשה חלק א');
}

describe('catalogue browsing', () => {
  it('credits Dicta with a link on every view', async () => {
    await renderApp();
    const links = screen.getAllByRole('link', { name: /דיקטה/ });
    expect(links.length).toBeGreaterThan(0);
    expect(links[0]).toHaveAttribute('href', 'https://library.dicta.org.il');
  });

  it('lists every book with its author, place and year', async () => {
    await renderApp();
    expect(screen.getByText('אחיעזר אבן העזר')).toBeInTheDocument();
    expect(screen.getByText(/מנשה בן פורת/)).toBeInTheDocument();
    expect(screen.getByText('3 ספרים')).toBeInTheDocument();
  });

  it('reports a load failure instead of rendering an empty catalogue', async () => {
    mockCatalogue(null, false);
    render(<App />);
    expect(await screen.findByText('טעינת רשימת הספרים נכשלה.')).toBeInTheDocument();
  });
});

describe('filtering', () => {
  it('narrows the list as you type', async () => {
    const user = userEvent.setup();
    await renderApp();

    await user.type(screen.getByPlaceholderText(/חיפוש/), 'אחיעזר');
    await waitFor(() => expect(screen.getByText('1 ספרים מתוך 3')).toBeInTheDocument());
    expect(screen.queryByText('אלפי מנשה חלק א')).not.toBeInTheDocument();
  });

  it('matches Hebrew regardless of gershayim and quoting', async () => {
    const user = userEvent.setup();
    await renderApp();

    // The title is spelled with ״ (U+05F4); the reader types nothing at all
    // in that position. Both must find it.
    await user.type(screen.getByPlaceholderText(/חיפוש/), 'עהת');
    await waitFor(() => expect(screen.getByText('אלפי מנשה עה״ת')).toBeInTheDocument());
    expect(screen.queryByText('אחיעזר אבן העזר')).not.toBeInTheDocument();
  });

  it('treats separate words as independent terms in any order', async () => {
    const user = userEvent.setup();
    await renderApp();

    await user.type(screen.getByPlaceholderText(/חיפוש/), 'פורת מנשה');
    await waitFor(() => expect(screen.getByText('1 ספרים מתוך 3')).toBeInTheDocument());
    expect(screen.getByText('אלפי מנשה חלק א')).toBeInTheDocument();
  });

  it('filters by category', async () => {
    const user = userEvent.setup();
    await renderApp();

    await user.click(screen.getByRole('checkbox', { name: /חסידות/ }));
    await waitFor(() => expect(screen.getByText('1 ספרים מתוך 3')).toBeInTheDocument());
    expect(screen.getByText('אלפי מנשה עה״ת')).toBeInTheDocument();
  });

  it('offers only the subcategories reachable under the chosen category', async () => {
    const user = userEvent.setup();
    await renderApp();

    const subGroup = () => screen.getByRole('group', { name: 'תת־קטגוריה' });
    expect(within(subGroup()).getAllByRole('checkbox')).toHaveLength(3);

    await user.click(screen.getByRole('checkbox', { name: /חסידות/ }));
    await waitFor(() => expect(within(subGroup()).getAllByRole('checkbox')).toHaveLength(1));
    expect(within(subGroup()).getByRole('checkbox', { name: /ת"ר/ })).toBeInTheDocument();
  });

  it('clears every filter at once', async () => {
    const user = userEvent.setup();
    await renderApp();

    await user.click(screen.getByRole('checkbox', { name: /חסידות/ }));
    await waitFor(() => expect(screen.getByText('1 ספרים מתוך 3')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'ניקוי הסינון' }));
    await waitFor(() => expect(screen.getByText('3 ספרים')).toBeInTheDocument());
  });

  it('says so plainly when nothing matches', async () => {
    const user = userEvent.setup();
    await renderApp();

    await user.type(screen.getByPlaceholderText(/חיפוש/), 'זזזזז');
    expect(await screen.findByText('לא נמצאו ספרים התואמים את החיפוש.')).toBeInTheDocument();
  });

  it('puts the query in the URL so a view can be shared', async () => {
    const user = userEvent.setup();
    await renderApp();

    await user.type(screen.getByPlaceholderText(/חיפוש/), 'אחיעזר');
    await waitFor(() => expect(window.location.search).toContain('q='));
    await user.click(screen.getByRole('checkbox', { name: /חסידות/ }));
    await waitFor(() => expect(window.location.search).toContain('cat='));
  });

  it('restores the query from the URL on load', async () => {
    window.history.replaceState(null, '', '/?q=' + encodeURIComponent('אחיעזר'));
    render(<App />);
    expect(await screen.findByText('אחיעזר אבן העזר')).toBeInTheDocument();
    expect(screen.queryByText('אלפי מנשה חלק א')).not.toBeInTheDocument();
  });
});

describe('sorting', () => {
  it('orders by year when asked', async () => {
    const user = userEvent.setup();
    await renderApp();

    await user.selectOptions(screen.getByRole('combobox'), 'year');
    await waitFor(() => {
      const titles = screen.getAllByRole('button').map((b) => b.textContent ?? '');
      const years = titles.filter((t) => /18|19/.test(t));
      expect(years[0]).toContain('אלפי מנשה חלק א'); // 1880
    });
  });
});

describe('book detail and download', () => {
  it('opens the book itself, showing its details while the text loads', async () => {
    const user = userEvent.setup();
    await renderApp();

    await user.click(screen.getByText('אלפי מנשה חלק א'));
    const reader = await screen.findByRole('dialog');
    // Catalogue metadata is on screen immediately, before the text arrives.
    expect(within(reader).getByText('מנשה בן פורת')).toBeInTheDocument();
    expect(within(reader).getByText(/1880/)).toBeInTheDocument();
    expect(await screen.findByText('פתח דבר לספר')).toBeInTheDocument();
  });

  it('exports the chosen format for the chosen book', async () => {
    const user = userEvent.setup();
    await renderApp();

    await user.click(screen.getByText('אלפי מנשה חלק א'));
    await screen.findByText('פתח דבר לספר');
    await user.click(screen.getByRole('button', { name: /הורדה/ }));
    await user.click(screen.getByRole('button', { name: /EPUB/ }));

    await waitFor(() => expect(exportBook).toHaveBeenCalledTimes(1));
    expect(exportBook.mock.calls[0][0].id).toBe('alfeimenashe');
    expect(exportBook.mock.calls[0][1]).toBe('epub');
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    await renderApp();

    await user.click(screen.getByText('אלפי מנשה חלק א'));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});

describe('the reader', () => {
  it('opens from a ?read= link, so a refresh keeps your place', async () => {
    // Regression: the URL-sync effect ran on the first render, before the
    // catalogue had loaded, and stripped `read` from the URL — so reloading
    // while reading dumped you back on the catalogue.
    window.history.replaceState(null, '', '/?read=alfeimenashe');
    render(<App />);

    expect(await screen.findByText('פתח דבר לספר')).toBeInTheDocument();
    expect(window.location.search).toContain('read=alfeimenashe');
  });

  it('records the opened book in the URL', async () => {
    const user = userEvent.setup();
    await renderApp();

    await user.click(screen.getByText('אלפי מנשה חלק א'));
    expect(await screen.findByText('פתח דבר לספר')).toBeInTheDocument();
    await waitFor(() => expect(window.location.search).toContain('read=alfeimenashe'));
  });

  it('opens at the folio a shared link cites', async () => {
    // ?p= is the scan folio, the same number the PDF and Word margins print,
    // so a citation survives any change to our own layout.
    window.history.replaceState(null, '', '/?read=alfeimenashe&p=2');
    render(<App />);
    expect(await screen.findByText('פתח דבר לספר')).toBeInTheDocument();
    await waitFor(() => expect(window.location.search).toContain('p=2'));
  });

  it('ignores a book id that matches nothing', async () => {
    window.history.replaceState(null, '', '/?read=nosuchbook');
    render(<App />);

    await screen.findByText('אלפי מנשה חלק א');
    await waitFor(() => expect(window.location.search).not.toContain('read='));
  });

  it('closing the reader returns to the catalogue and clears the URL', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', '/?read=alfeimenashe');
    render(<App />);
    await screen.findByText('פתח דבר לספר');

    await user.keyboard('{Escape}');
    await waitFor(() => expect(window.location.search).not.toContain('read='));
    expect(screen.getByText('אלפי מנשה חלק א')).toBeInTheDocument();
  });
});

describe('commentaries, fetched only when wanted', () => {
  const shelf = {
    facets: { categories: [], subcategories: [], total: 1, fetchedAt: '2026-09-05' },
    books: [
      makeBook({
        id: 'sefaria:base',
        provider: 'sefaria',
        kind: 'book',
        title: 'בראשית',
        key: 'בראשית',
      }),
    ],
    deferred: [{ file: 'books-sefaria-commentaries.json', kind: 'commentary', count: 5416 }],
  };
  const commentaries = {
    facets: { categories: [], subcategories: [], total: 1, fetchedAt: '2026-09-05' },
    books: [
      makeBook({
        id: 'sefaria:rashi',
        provider: 'sefaria',
        kind: 'commentary',
        title: 'רש״י על בראשית',
        key: 'רשי על בראשית',
      }),
    ],
  };

  function mockSplit() {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        const name = String(url);
        calls.push(name);
        const body = name.includes('commentaries')
          ? commentaries
          : name.includes('sefaria')
            ? shelf
            : catalogue;
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
      }),
    );
    return calls;
  }

  it('leaves the commentary file alone on a normal visit', async () => {
    const calls = mockSplit();
    render(<App />);
    await screen.findByText('אלפי מנשה חלק א');
    // 5,416 rows nobody asked for is most of the download.
    expect(calls.some((c) => c.includes('commentaries'))).toBe(false);
  });

  it('still offers them, counted, before they are loaded', async () => {
    mockSplit();
    render(<App />);
    await screen.findByText('אלפי מנשה חלק א');
    expect(screen.getByRole('checkbox', { name: /פירושים/ })).toBeInTheDocument();
    expect(screen.getByText(/5,416|5416/)).toBeInTheDocument();
  });

  it('fetches them once the reader asks, and shows them', async () => {
    const user = userEvent.setup();
    const calls = mockSplit();
    render(<App />);
    await screen.findByText('אלפי מנשה חלק א');

    await user.click(screen.getByRole('checkbox', { name: /פירושים/ }));

    expect(await screen.findByText('רש״י על בראשית')).toBeInTheDocument();
    expect(calls.filter((c) => c.includes('commentaries'))).toHaveLength(1);
  });

  it('resolves a link to a commentary that the first load did not carry', async () => {
    mockSplit();
    window.history.replaceState(null, '', '/?read=sefaria:rashi');
    render(<App />);
    // The id must survive long enough for the deferred file to arrive.
    expect(await screen.findByText('פתח דבר לספר')).toBeInTheDocument();
    expect(window.location.search).toContain('read=sefaria%3Arashi');
  });
});
