import { canonicalCategory, categoryOrder } from './categories';
import { providerLabel } from './providers/registry';
import type { Book, BookKind, Catalogue, Deferred, Facet, Facets } from './types';

export { providerLabel };

export const KIND_LABEL: Record<BookKind, string> = {
  book: 'ספרים',
  commentary: 'פירושים',
};

export function kindLabel(kind: BookKind): string {
  return KIND_LABEL[kind] ?? KIND_LABEL.book;
}

function tally(books: Book[], of: (b: Book) => string): Facet[] {
  const counts = new Map<string, number>();
  for (const b of books) {
    const key = of(b);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
}

/**
 * Fold the per-library catalogues into one.
 *
 * Two things happen here that cannot happen in the fetch scripts, because both
 * need to see every library at once:
 *
 * - Categories are mapped onto one shared vocabulary (see ./categories).
 * - Facets are re-counted rather than concatenated. Each library counts its own
 *   facets over its own books, so adding the shipped lists would list a shared
 *   category twice, each with half the true count.
 *
 * Books are not de-duplicated. Around 32 titles exist in both libraries, but
 * they are different editions — a Dicta scan and a Sefaria transcription — and
 * collapsing them would silently pick one.
 */
export function mergeCatalogues(parts: Catalogue[], loaded = new Set<string>()): Catalogue {
  // What is catalogued but not yet fetched. Counted in the facets so the reader
  // can see the commentaries exist and ask for them.
  const deferred: Deferred[] = parts
    .flatMap((p) => p.deferred ?? [])
    .filter((d) => !loaded.has(d.file));
  const pending = (kind: BookKind) =>
    deferred.filter((d) => d.kind === kind).reduce((n, d) => n + d.count, 0);

  const books = parts
    .flatMap((p) => p.books)
    .map((b) => ({ ...b, category: canonicalCategory(b), source: providerLabel(b.provider) }));

  const facets: Facets = {
    // By subject rather than by size: a category list that reorders itself as
    // the corpus grows is harder to learn than a fixed one.
    categories: tally(books, (b) => b.category).sort(
      (a, b) => categoryOrder(a.name) - categoryOrder(b.name),
    ),
    subcategories: tally(books, (b) => b.subcategory),
    sources: tally(books, (b) => providerLabel(b.provider)),
    // Ordered book-then-commentary, so the default sits first.
    kinds: (['book', 'commentary'] as BookKind[])
      .map((k) => ({
        name: kindLabel(k),
        count: books.filter((b) => b.kind === k).length + pending(k),
      }))
      .filter((f) => f.count > 0),
    total: books.length + deferred.reduce((n, d) => n + d.count, 0),
    // The oldest refresh, so the date shown is one every book is at least as
    // new as rather than the most flattering of the two.
    fetchedAt: parts.map((p) => p.facets.fetchedAt).sort()[0] ?? '',
  };

  return { facets, books, deferred };
}
