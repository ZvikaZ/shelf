import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { BookList } from './components/BookList';
import { Filters } from './components/Filters';
import {
  availableSubcategories,
  EMPTY_QUERY,
  filterBooks,
  isActive,
  paramsToQuery,
  queryToParams,
  sortBooks,
  type Query,
  type SortKey,
} from './lib/search';
import { KIND_LABEL, mergeCatalogues } from './lib/catalogue';
import { PROVIDERS, PROVIDER_IDS } from './lib/providers/registry';
import type { Catalogue } from './lib/types';

// The reader carries the zip reader and parser with it; browsing the catalogue
// should not pay for that until a book is actually opened.
const Reader = lazy(() =>
  import('./components/Reader').then((m) => ({ default: m.Reader })),
);

async function loadCatalogue(name: string): Promise<Catalogue> {
  const res = await fetch(`${import.meta.env.BASE_URL}${name}`);
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

function folioFromParams(params: URLSearchParams): number | null {
  const n = Number(params.get('p'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

const DICTA_SITE = 'https://library.dicta.org.il';
const SEFARIA_SITE = 'https://www.sefaria.org';

export function App() {
  const [parts, setParts] = useState<Catalogue[] | null>(null);
  /** Deferred catalogue files fetched since, keyed by file name. */
  const [extras, setExtras] = useState<{ file: string; part: Catalogue }[]>([]);
  const [loadingExtra, setLoadingExtra] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [query, setQuery] = useState<Query>(() =>
    paramsToQuery(new URLSearchParams(window.location.search)),
  );
  const [sort, setSort] = useState<SortKey>('title');
  // Seeded from the URL at mount, not after the catalogue arrives: the effect
  // that syncs the URL runs on the first render too, and would otherwise strip
  // `read` before anything had a chance to restore it.
  const [readingId, setReadingId] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get('read'),
  );
  // The scan folio, so a link can cite the same place the PDF and Word margins
  // print — not our own pagination, which would not survive a reformat.
  const [readingFolio, setReadingFolio] = useState<number | null>(() =>
    folioFromParams(new URLSearchParams(window.location.search)),
  );

  useEffect(() => {
    // One file per library, merged here: they refresh on separate schedules.
    Promise.all(PROVIDER_IDS.map((id) => loadCatalogue(PROVIDERS[id].catalogue)))
      .then(setParts)
      .catch(() => setLoadError('טעינת רשימת הספרים נכשלה.'));
  }, []);

  const loadedFiles = useMemo(() => new Set(extras.map((e) => e.file)), [extras]);

  const catalogue = useMemo(
    () =>
      parts ? mergeCatalogues([...parts, ...extras.map((e) => e.part)], loadedFiles) : null,
    [parts, extras, loadedFiles],
  );

  // Back, forward and any other outside change to the URL.
  useEffect(() => {
    const onPop = () => {
      const params = new URLSearchParams(window.location.search);
      setQuery(paramsToQuery(params));
      setReadingId(params.get('read'));
      setReadingFolio(folioFromParams(params));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Keep the URL in step so a filtered view can be shared or bookmarked.
  useEffect(() => {
    const params = queryToParams(query);
    if (readingId) params.set('read', readingId);
    if (readingId && readingFolio) params.set('p', String(readingFolio));
    const search = params.toString();
    window.history.replaceState(null, '', search ? `?${search}` : window.location.pathname);
  }, [query, readingId, readingFolio]);

  const results = useMemo(() => {
    if (!catalogue) return [];
    return sortBooks(filterBooks(catalogue.books, query), sort);
  }, [catalogue, query, sort]);

  // A book opened for reading is addressable, so a link points at the text.
  const reading = useMemo(
    () => (catalogue && readingId ? (catalogue.books.find((b) => b.id === readingId) ?? null) : null),
    [catalogue, readingId],
  );

  const pending = catalogue?.deferred ?? [];
  // A link may point at a commentary, which is not in the first load.
  const unresolvedRead = readingId !== null && catalogue !== null && !reading;
  const wantsDeferred = query.kinds.includes(KIND_LABEL.commentary);

  useEffect(() => {
    if (pending.length === 0 || loadingExtra) return;
    if (!wantsDeferred && !unresolvedRead) return;
    setLoadingExtra(true);
    Promise.all(pending.map(async (d) => ({ file: d.file, part: await loadCatalogue(d.file) })))
      .then((loaded) => setExtras((prev) => [...prev, ...loaded]))
      .catch(() => setLoadError('טעינת הפירושים נכשלה.'))
      .finally(() => setLoadingExtra(false));
  }, [pending, wantsDeferred, unresolvedRead, loadingExtra]);

  // Drop an id that matches nothing — but only once there is nothing left to
  // fetch, or a link to a commentary would be discarded before it arrived.
  useEffect(() => {
    if (catalogue && readingId && !reading && pending.length === 0 && !loadingExtra) {
      setReadingId(null);
    }
  }, [catalogue, readingId, reading, pending.length, loadingExtra]);

  const subs = useMemo(
    () => (catalogue ? availableSubcategories(catalogue.books, query) : []),
    [catalogue, query],
  );

  return (
    <>
      <header className="masthead">
        <div className="masthead-inner">
          <h1>מדף</h1>
          <p className="tagline">
            ספריית דיקטה וספריא — לעיון, לחיפוש ולהורדה כ‑EPUB, Word או PDF
          </p>
          <p className="credit">
            כל הטקסטים באדיבות{' '}
            <a href={DICTA_SITE} target="_blank" rel="noreferrer">
              הספרייה של דיקטה
            </a>{' '}
            ו־
            <a href={SEFARIA_SITE} target="_blank" rel="noreferrer">
              ספריא
            </a>
            . תודה על המיזמים ועל שחרור הטקסטים לשימוש חופשי.
          </p>
        </div>
      </header>

      {loadError && <p className="empty">{loadError}</p>}

      {catalogue && (
        <main className="layout">
          <Filters
            facets={catalogue.facets}
            subcategories={subs}
            query={query}
            onChange={setQuery}
          />

          <section>
            <div className="toolbar">
              <span className="result-count">
                {loadingExtra ? (
                  'טוען פירושים…'
                ) : (
                  <>
                    {results.length.toLocaleString('he-IL')} ספרים
                    {isActive(query) &&
                      ` מתוך ${catalogue.facets.total.toLocaleString('he-IL')}`}
                  </>
                )}
              </span>
              {isActive(query) && (
                <button type="button" className="link-button" onClick={() => setQuery(EMPTY_QUERY)}>
                  ניקוי הסינון
                </button>
              )}
              <label style={{ marginInlineStart: 'auto', display: 'flex', gap: 8 }}>
                <span className="result-count">מיון</span>
                <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
                  <option value="title">לפי שם</option>
                  <option value="author">לפי מחבר</option>
                  <option value="year">לפי שנה</option>
                </select>
              </label>
            </div>

            {/* Selecting a book opens it; the downloads live in the reader. */}
            <BookList
              books={results}
              onSelect={(b) => {
                setReadingId(b.id);
                setReadingFolio(null);
              }}
            />
          </section>
        </main>
      )}

      {reading && (
        <Suspense fallback={<p className="empty">טוען…</p>}>
          <Reader
            // Keyed so each book gets a fresh reader: without it the scroll
            // restore guard and current position carry over from the last one.
            key={reading.id}
            book={reading}
            initialFolio={readingFolio}
            onFolio={setReadingFolio}
            onClose={() => {
              setReadingId(null);
              setReadingFolio(null);
            }}
          />
        </Suspense>
      )}

      <footer className="site-foot">
        {/* Built from the provider registry, so adding a library credits it
            here too. The licence is deliberately not named: Sefaria's varies by
            edition, and claiming one for the whole shelf was untrue. */}
        <p style={{ margin: '0 0 6px' }}>
          הטקסטים באדיבות{' '}
          {PROVIDER_IDS.map((id, i) => (
            <span key={id}>
              {i > 0 && (i === PROVIDER_IDS.length - 1 ? ' ו' : ' · ')}
              <a href={PROVIDERS[id].site} target="_blank" rel="noreferrer">
                {PROVIDERS[id].label}
              </a>
            </span>
          ))}
          {' '}— מיזמים המנגישים טקסטים תורניים לציבור ללא עלות. תודה על העבודה ועל שחרור
          הטקסטים לשימוש חופשי.
        </p>
        <p style={{ margin: 0 }}>
          אתר זה הוא ממשק עיון והורדה בלבד, ואינו קשור רשמית לאף אחד מהם. הרישיון משתנה לפי
          הספר והמהדורה, ומצוין בכל ספר ובכל קובץ שמופק ממנו.
        </p>
      </footer>
    </>
  );
}
