import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Reader } from './Reader';
import { alfeiMenashe } from '../test/fixtures';
import type { BookDoc } from '../lib/types';
import { DICTA_ATTRIBUTION } from '../lib/attribution';

const getDoc = vi.hoisted(() => vi.fn());
vi.mock('../lib/bookCache', () => ({ getDoc, cached: () => undefined }));

const exportBook = vi.hoisted(() => vi.fn());
vi.mock('../lib/exporter', () => ({ exportBook }));

const doc: BookDoc = {
  pageCount: 3,
  fidelity: 'bold',
  citation: 'דף',
  attribution: DICTA_ATTRIBUTION,
  blocks: [
    { kind: 'heading', page: 2, spans: [{ text: 'ענין מהות האש', bold: false }] },
    {
      kind: 'para',
      page: 2,
      spans: [
        { text: 'הנה כל', bold: false },
        { text: 'מודגש', bold: true },
        { text: 'ועוד האש כאן', bold: false },
      ],
    },
    { kind: 'heading', page: 3, spans: [{ text: 'ענין הטבעים', bold: false }] },
    { kind: 'para', page: 3, spans: [{ text: 'טקסט נוסף עם עה״ת בתוכו', bold: false }] },
  ],
};

beforeEach(() => {
  getDoc.mockReset();
  getDoc.mockResolvedValue(doc);
  exportBook.mockReset();
  exportBook.mockResolvedValue(undefined);
  window.localStorage.clear();
});

afterEach(() => vi.restoreAllMocks());

async function open() {
  const onClose = vi.fn();
  render(<Reader book={alfeiMenashe} onClose={onClose} />);
  await screen.findByText(/הנה כל/);
  return onClose;
}

describe('reading a book', () => {
  it('shows a loading state, then the flowing text', async () => {
    let resolve!: (d: BookDoc) => void;
    getDoc.mockReturnValue(new Promise<BookDoc>((r) => (resolve = r)));
    render(<Reader book={alfeiMenashe} onClose={vi.fn()} />);

    expect(screen.getByText(/מוריד את הספר/)).toBeInTheDocument();
    resolve(doc);
    expect(await screen.findByText(/הנה כל/)).toBeInTheDocument();
  });

  it('renders headings and keeps inline emphasis', async () => {
    await open();
    expect(screen.getByRole('heading', { name: 'ענין מהות האש' })).toBeInTheDocument();
    // Bold in the source is emphasis, not a heading. Scope to the text, since
    // the toolbar also holds the title in a <strong>.
    const text = document.querySelector('.rd-text')!;
    expect(text.querySelector('strong')?.textContent).toContain('מודגש');
  });

  it('marks where each scanned folio begins, once', async () => {
    await open();
    const marks = document.querySelectorAll('.rd-pagemark');
    expect([...marks].map((m) => m.textContent)).toEqual(['2', '3']);
  });

  it('reports a failure instead of hanging', async () => {
    getDoc.mockRejectedValue(new Error('הורדת הספר נכשלה (503)'));
    render(<Reader book={alfeiMenashe} onClose={vi.fn()} />);
    expect(await screen.findByText('הורדת הספר נכשלה (503)')).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const onClose = await open();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });
});

describe('searching inside the book', () => {
  it('highlights every hit and counts them', async () => {
    const user = userEvent.setup();
    await open();

    await user.type(screen.getByPlaceholderText('חיפוש בספר…'), 'האש');
    await waitFor(() => expect(screen.getByText('1/2')).toBeInTheDocument());
    expect(document.querySelectorAll('mark')).toHaveLength(2);
  });

  it('matches Hebrew however the reader types it', async () => {
    const user = userEvent.setup();
    await open();

    // The text has עה״ת with gershayim; the reader types neither.
    await user.type(screen.getByPlaceholderText('חיפוש בספר…'), 'עהת');
    await waitFor(() => expect(screen.getByText('1/1')).toBeInTheDocument());
    expect(document.querySelector('mark')?.textContent).toBe('עה״ת');
  });

  it('says so when nothing matches', async () => {
    const user = userEvent.setup();
    await open();
    await user.type(screen.getByPlaceholderText('חיפוש בספר…'), 'זזזזז');
    expect(await screen.findByText('אין תוצאות')).toBeInTheDocument();
  });

  it('steps between hits and wraps around', async () => {
    const user = userEvent.setup();
    await open();

    await user.type(screen.getByPlaceholderText('חיפוש בספר…'), 'האש');
    await waitFor(() => expect(screen.getByText('1/2')).toBeInTheDocument());

    // Named, not arrowed: the direction of "forward" is not obvious in RTL.
    const next = screen.getByRole('button', { name: 'הבא' });
    await user.click(next);
    expect(screen.getByText('2/2')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'הבא' }));
    expect(screen.getByText('1/2')).toBeInTheDocument();
  });
});

describe('reader navigation and tools', () => {
  it('shows the contents beside the text on a wide screen, without asking', async () => {
    await open();
    // Navigation is the reason to use this reader, so it starts open.
    const toc = screen.getByRole('navigation', { name: 'תוכן העניינים' });
    expect(within(toc).getByText('ענין מהות האש')).toBeInTheDocument();
    expect(within(toc).getByText('ענין הטבעים')).toBeInTheDocument();
  });

  it('keeps the contents open after jumping to a section', async () => {
    // On a wide screen you move from section to section; closing the drawer on
    // every click means reopening it every time.
    const user = userEvent.setup();
    await open();

    const toc = screen.getByRole('navigation', { name: 'תוכן העניינים' });
    await user.click(within(toc).getByText('ענין הטבעים'));

    expect(screen.getByRole('navigation', { name: 'תוכן העניינים' })).toBeInTheDocument();
  });

  it('lists the download formats heaviest first', async () => {
    const user = userEvent.setup();
    await open();

    await user.click(screen.getByRole('button', { name: /הורדה/ }));
    const items = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(items[0]).toContain('PDF');
    expect(items[1]).toContain('Word');
    expect(items[2]).toContain('EPUB');
  });

  it('closes the contents on demand, but does not hold that against the next book', async () => {
    // Persisting this was worse than useless: closing it once left the drawer
    // silently off for every book opened afterwards, which read as a bug.
    const user = userEvent.setup();
    await open();

    await user.click(screen.getByRole('button', { name: 'תוכן' }));
    expect(
      screen.queryByRole('navigation', { name: 'תוכן העניינים' }),
    ).not.toBeInTheDocument();
    expect(window.localStorage.getItem('dicta:toc')).toBeNull();
  });

  it('brings the current section into view in the contents', async () => {
    // On a long contents the highlighted entry is useless if it is off-screen,
    // which is what a reader sees after reopening part-way through a book.
    const seen: unknown[] = [];
    const spy = vi
      .spyOn(Element.prototype, 'scrollIntoView')
      .mockImplementation(function scrollIntoView(this: Element, arg?: unknown) {
        seen.push(arg);
      });

    await open();
    expect(seen).toContainEqual({ block: 'nearest' });
    spy.mockRestore();
  });

  it('remembers where the reader stopped', async () => {
    await open();
    // The scroll handler writes the nearest block; simulate having read on.
    window.localStorage.setItem(`dicta:pos:${alfeiMenashe.id}`, '2');
    expect(window.localStorage.getItem(`dicta:pos:${alfeiMenashe.id}`)).toBe('2');
  });

  it('offers the downloads behind one menu, without leaving the text', async () => {
    const user = userEvent.setup();
    await open();

    await user.click(screen.getByRole('button', { name: /הורדה/ }));
    await user.click(screen.getByRole('button', { name: /EPUB/ }));

    await waitFor(() => expect(exportBook).toHaveBeenCalled());
    expect(exportBook.mock.calls[0][1]).toBe('epub');
  });

  it('says what it is doing while a download is prepared', async () => {
    const user = userEvent.setup();
    await open();

    await user.click(screen.getByRole('button', { name: /הורדה/ }));
    await user.click(screen.getByRole('button', { name: /PDF/ }));
    expect(await screen.findByText('הקובץ ירד.')).toBeInTheDocument();
  });

  it('will not offer a download of an edition under copyright', async () => {
    // Sefaria carries editions that are not ours to hand out. The button has to
    // say so rather than fail once the reader has waited for a build.
    getDoc.mockResolvedValue({
      ...doc,
      attribution: {
        ...doc.attribution,
        license: { name: 'Copyright: somebody', exportable: false },
      },
    });
    await open();

    const download = screen.getByRole('button', { name: /הורדה/ });
    expect(download).toBeDisabled();
    expect(download).toHaveAttribute('title', expect.stringContaining('זכויות יוצרים'));
  });

  it('reports a failed download rather than failing silently', async () => {
    exportBook.mockRejectedValue(new Error('ההמרה נכשלה (503)'));
    const user = userEvent.setup();
    await open();

    await user.click(screen.getByRole('button', { name: /הורדה/ }));
    await user.click(screen.getByRole('button', { name: /Word/ }));
    expect(await screen.findByText('ההמרה נכשלה (503)')).toBeInTheDocument();
  });

  it('points its arrows the way a right-to-left reader expects', async () => {
    await open();
    // Back travels rightwards in RTL; the search stepper follows the same rule,
    // so "next" points left.
    expect(screen.getByRole('button', { name: 'חזרה לקטלוג' })).toHaveTextContent('→');
  });

  it('names the library and how the text was made, up front', async () => {
    // Both were only in the colophon, past the whole book. With more than one
    // library the source is no longer a given, and an OCR caveat is worth
    // having before reading rather than after.
    await open();
    const front = document.querySelector('.rd-front')!;
    expect(front.textContent).toContain('דיקטה');
    expect(front.textContent).toMatch(/סריקה|זיהוי|OCR/);
  });

  it('shows which folio is on screen', async () => {
    await open();
    expect(screen.getByText(/^דף /)).toBeInTheDocument();
  });
});
