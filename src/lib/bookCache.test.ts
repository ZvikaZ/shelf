import { describe, expect, it, vi, beforeEach } from 'vitest';
import { makeBook, makeDoc } from '../test/fixtures';

const loadBook = vi.hoisted(() => vi.fn());
// bookCache loads through ./providers, not the ./fetchBook re-export.
vi.mock('./providers', () => ({ loadBook }));

const { getDoc, cached } = await import('./bookCache');

const doc = makeDoc({ blocks: [{ kind: 'para', page: 1, spans: [{ text: 'א', bold: false }] }] });

beforeEach(() => {
  loadBook.mockReset();
  loadBook.mockResolvedValue(doc);
});

describe('parsed books, kept for the session', () => {
  it('parses a book once however many times it is asked for', async () => {
    // Reading a book and then exporting it must not fetch and parse it twice:
    // that is seconds of work and a megabyte of download for the same result.
    const book = makeBook({ id: 'dicta:once' });
    await getDoc(book);
    await getDoc(book);
    await getDoc(book);
    expect(loadBook).toHaveBeenCalledTimes(1);
  });

  it('keeps books apart', async () => {
    await getDoc(makeBook({ id: 'dicta:a' }));
    await getDoc(makeBook({ id: 'dicta:b' }));
    expect(loadBook).toHaveBeenCalledTimes(2);
  });

  it('reports what is already in hand, without fetching', async () => {
    const book = makeBook({ id: 'dicta:held' });
    expect(cached(book.id)).toBeUndefined();
    await getDoc(book);
    expect(cached(book.id)).toBe(doc);
    expect(loadBook).toHaveBeenCalledTimes(1);
  });
});
