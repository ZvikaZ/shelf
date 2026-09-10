import { KIND_LABEL, kindLabel } from './catalogue';
import { providerLabel } from './providers/registry';
import type { Book } from './types';

// Hebrew points/accents, plus the geresh/gershayim variants that otherwise make
// אלפי מנשה עה"ת unmatchable by anyone typing a plain apostrophe (or nothing).
const NIKUD = /[֑-ׇ]/g;
const MARKS = /[׳״"'`‘’“”]/g;

export function normalise(value: string | null | undefined): string {
  return (value ?? '')
    .replace(NIKUD, '')
    .replace(MARKS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export interface Query {
  text: string;
  categories: string[];
  subcategories: string[];
  sources: string[];
  /** Book kinds to show. Defaults to everything — see EMPTY_QUERY. */
  kinds: string[];
}

export const EMPTY_QUERY: Query = {
  text: '',
  categories: [],
  subcategories: [],
  sources: [],
  // Both, so a search covers the whole shelf without anyone having to know
  // there is a second half to switch on. The cost is real — commentaries are
  // a separate 4 MB catalogue, fetched on first paint rather than on demand —
  // and they outnumber books three to one, most being per-tractate repeats.
  kinds: [KIND_LABEL.book, KIND_LABEL.commentary],
};

export function isActive(q: Query): boolean {
  return (
    q.text.trim() !== '' ||
    q.categories.length > 0 ||
    q.subcategories.length > 0 ||
    q.sources.length > 0 ||
    // Only counts as filtering once it differs from the default.
    q.kinds.join('|') !== EMPTY_QUERY.kinds.join('|')
  );
}

/** Every whitespace-separated term must appear; order does not matter. */
export function matchesText(book: Book, text: string): boolean {
  const terms = normalise(text).split(' ').filter(Boolean);
  if (terms.length === 0) return true;
  return terms.every((t) => book.key.includes(t));
}

export function filterBooks(books: Book[], q: Query): Book[] {
  const terms = normalise(q.text).split(' ').filter(Boolean);
  const cats = new Set(q.categories);
  const subs = new Set(q.subcategories);
  const srcs = new Set(q.sources);
  const kinds = new Set(q.kinds);

  return books.filter((b) => {
    if (cats.size && !cats.has(b.category)) return false;
    if (subs.size && !subs.has(b.subcategory)) return false;
    if (srcs.size && !srcs.has(providerLabel(b.provider))) return false;
    if (kinds.size && !kinds.has(kindLabel(b.kind))) return false;
    return terms.every((t) => b.key.includes(t));
  });
}

export type SortKey = 'title' | 'year' | 'author';

export function sortBooks(books: Book[], key: SortKey): Book[] {
  const he = new Intl.Collator('he');
  return [...books].sort((a, b) => {
    if (key === 'year') return (a.year ?? 9999) - (b.year ?? 9999) || he.compare(a.title, b.title);
    if (key === 'author') return he.compare(a.author ?? '', b.author ?? '') || he.compare(a.title, b.title);
    return he.compare(a.title, b.title);
  });
}

/** Subcategories present in the books that pass everything except the subcategory filter. */
export function availableSubcategories(books: Book[], q: Query): string[] {
  const scoped = filterBooks(books, { ...q, subcategories: [] });
  return [...new Set(scoped.map((b) => b.subcategory))].sort(new Intl.Collator('he').compare);
}

/** Encode/decode query state in the URL so a filtered view is shareable. */
export function queryToParams(q: Query): URLSearchParams {
  const p = new URLSearchParams();
  if (q.text.trim()) p.set('q', q.text.trim());
  if (q.categories.length) p.set('cat', q.categories.join('|'));
  if (q.subcategories.length) p.set('sub', q.subcategories.join('|'));
  if (q.sources.length) p.set('src', q.sources.join('|'));
  if (q.kinds.join('|') !== EMPTY_QUERY.kinds.join('|')) p.set('kind', q.kinds.join('|'));
  return p;
}

export function paramsToQuery(p: URLSearchParams): Query {
  return {
    text: p.get('q') ?? '',
    categories: p.get('cat')?.split('|').filter(Boolean) ?? [],
    subcategories: p.get('sub')?.split('|').filter(Boolean) ?? [],
    sources: p.get('src')?.split('|').filter(Boolean) ?? [],
    kinds: p.get('kind')?.split('|').filter(Boolean) ?? EMPTY_QUERY.kinds,
  };
}
