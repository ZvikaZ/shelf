import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getDoc } from '../lib/bookCache';
import { findMatches, segment, type Match } from '../lib/findInText';
import { FORMAT_HINT, FORMAT_LABEL } from '../lib/formats';
import { providerLabel } from '../lib/providers/registry';
import { blockText } from '../lib/parseOcr';
import { tocEntries } from '../lib/toc';
import { blockLabel, type Block, type Book, type BookDoc, type ExportFormat } from '../lib/types';

const SIZES = [16, 18, 20, 23, 26];
const DEFAULT_SIZE = 1;
const SIZE_KEY = 'dicta:size';

/** Wide enough for the contents to sit beside the text rather than over it. */
function wideScreen(): boolean {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia('(min-width: 900px)').matches
    : true;
}

interface Props {
  book: Book;
  onClose: () => void;
  /** Scan folio to open at, from the URL. Takes precedence over the saved spot. */
  initialFolio?: number | null;
  /** Reports the folio now being read, so the URL can cite it. */
  onFolio?: (folio: number) => void;
}

function positionKey(bookId: string): string {
  return `dicta:pos:${bookId}`;
}

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null; // private mode, blocked storage
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* not worth telling the reader about */
  }
}

/** Render one block, preserving emphasis and highlighting search hits. */
function BlockView({ block, hits }: { block: Block; hits: Match[] }) {
  const children: React.ReactNode[] = [];
  let offset = 0;

  block.spans.forEach((span, i) => {
    if (i > 0) {
      children.push(' ');
      offset += 1; // blockText joins spans with a single space
    }
    const from = offset;
    const to = offset + span.text.length;
    const ranges = hits
      .filter((h) => h.start < to && h.end > from)
      .map((h) => ({ start: Math.max(h.start, from) - from, end: Math.min(h.end, to) - from }));

    const pieces = segment(span.text, ranges).map((seg, k) =>
      seg.hit ? (
        <mark key={`${i}-${k}`}>{seg.text}</mark>
      ) : (
        <span key={`${i}-${k}`}>{seg.text}</span>
      ),
    );
    children.push(span.bold ? <strong key={i}>{pieces}</strong> : <span key={i}>{pieces}</span>);
    offset = to;
  });

  if (block.kind === 'heading') return <h2 className="rd-heading">{children}</h2>;
  return <p className={block.layer ? 'rd-para rd-commentary' : 'rd-para'}>{children}</p>;
}

export function Reader({ book, onClose, initialFolio, onFolio }: Props) {
  const [doc, setDoc] = useState<BookDoc | null>(null);
  const [error, setError] = useState('');
  const [ratio, setRatio] = useState(0);
  const [query, setQuery] = useState('');
  const [hitIndex, setHitIndex] = useState(0);
  const [sizeIndex, setSizeIndex] = useState(() => {
    const saved = Number(readStored(SIZE_KEY));
    return Number.isInteger(saved) && saved >= 0 && saved < SIZES.length ? saved : DEFAULT_SIZE;
  });
  // Navigation is the point of this reader, so the contents starts open
  // wherever there is room. Deliberately not remembered: closing it once should
  // not silently disable it for every book opened afterwards.
  const [showToc, setShowToc] = useState(wideScreen);
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [status, setStatus] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [current, setCurrent] = useState(0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLLIElement>(null);
  const restored = useRef(false);

  useEffect(() => {
    let live = true;
    getDoc(book, (_stage, r) => live && setRatio(r))
      .then((d) => live && setDoc(d))
      .catch((e) => live && setError(e instanceof Error ? e.message : 'טעינת הספר נכשלה.'));
    return () => {
      live = false;
    };
  }, [book]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuOpen((open) => {
          if (!open) onClose();
          return false;
        });
      }
      if (e.key === '/' && e.target === document.body) {
        e.preventDefault();
        document.getElementById('rd-search')?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const plain = useMemo(() => (doc ? doc.blocks.map(blockText) : []), [doc]);
  const matches = useMemo(() => findMatches(plain, query), [plain, query]);
  const entries = useMemo(() => (doc ? tocEntries(doc) : []), [doc]);

  const hitsByBlock = useMemo(() => {
    const m = new Map<number, Match[]>();
    for (const hit of matches) {
      const list = m.get(hit.block);
      if (list) list.push(hit);
      else m.set(hit.block, [hit]);
    }
    return m;
  }, [matches]);

  const scrollToBlock = useCallback((index: number) => {
    document.getElementById(`rd-b${index}`)?.scrollIntoView({ block: 'center' });
  }, []);

  // Open where asked: a folio in the link wins over the remembered spot,
  // because an explicit link is a deliberate request.
  useEffect(() => {
    if (!doc || restored.current) return;
    restored.current = true;

    if (initialFolio) {
      const at = doc.blocks.findIndex((b) => b.page === initialFolio);
      if (at >= 0) {
        requestAnimationFrame(() => scrollToBlock(at));
        return;
      }
    }
    const saved = Number(readStored(positionKey(book.id)));
    if (Number.isFinite(saved) && saved > 0) {
      requestAnimationFrame(() => scrollToBlock(saved));
    }
  }, [doc, book.id, initialFolio, scrollToBlock]);

  // Remember roughly where the reader stopped.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !doc) return;
    let timer = 0;
    const onScroll = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const mid = el.scrollTop + el.clientHeight / 2;
        const blocks = el.querySelectorAll<HTMLElement>('[data-block]');
        for (const node of blocks) {
          if (node.offsetTop + node.offsetHeight >= mid) {
            const index = Number(node.dataset.block ?? 0);
            writeStored(positionKey(book.id), String(index));
            setCurrent(index);
            const folio = Number(node.dataset.folio);
            if (Number.isFinite(folio)) onFolio?.(folio);
            break;
          }
        }
      }, 400);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      window.clearTimeout(timer);
    };
  }, [doc, book.id, onFolio]);

  // Dismiss the download menu the way people expect: click anywhere else.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.rd-menu-wrap')) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  useEffect(() => writeStored(SIZE_KEY, String(sizeIndex)), [sizeIndex]);

  useEffect(() => setHitIndex(0), [query]);

  useEffect(() => {
    if (matches.length > 0) scrollToBlock(matches[Math.min(hitIndex, matches.length - 1)].block);
  }, [hitIndex, matches, scrollToBlock]);

  const download = async (format: ExportFormat) => {
    if (!doc) return;
    setBusy(format);
    setMenuOpen(false);
    setStatus(`מכין ${FORMAT_LABEL[format]}…`);
    setProgress(0);
    try {
      const { exportBook } = await import('../lib/exporter');
      await exportBook(book, format, (stage, ratio) => {
        setStatus(stage === 'download' ? 'מוריד את הטקסט…' : `מכין ${FORMAT_LABEL[format]}…`);
        setProgress(ratio);
      });
      setStatus('הקובץ ירד.');
      setProgress(null);
      window.setTimeout(() => setStatus(''), 4000);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'ההמרה נכשלה.');
      setProgress(null);
    } finally {
      setBusy(null);
    }
  };

  const exportable = doc?.attribution.license.exportable ?? true;
  const currentBlock = doc?.blocks[current];
  const currentFolio =
    currentBlock && [doc?.citation, blockLabel(currentBlock)].filter(Boolean).join(' ');

  // The section the reader is inside: the last heading at or above this block.
  const activeEntry = useMemo(() => {
    if (!doc) return null;
    let id: string | null = null;
    for (let i = 0; i <= current && i < doc.blocks.length; i++) {
      if (doc.blocks[i].kind === 'heading') id = `h${i}`;
    }
    return id;
  }, [doc, current]);

  // Keep the section you are in visible in the contents. `nearest` moves the
  // list only when the entry is actually off-screen, so reading down the page
  // does not drag the drawer about.
  useEffect(() => {
    if (showToc) activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeEntry, showToc]);

  const step = (delta: number) => {
    if (matches.length === 0) return;
    setHitIndex((i) => (i + delta + matches.length) % matches.length);
  };

  let lastPage = -1;

  return (
    <div className="reader" role="dialog" aria-modal="true" aria-label={book.title}>
      <header className="rd-bar">
        {/* Right-to-left interface: back points right, forward points left. */}
        <button type="button" className="rd-btn" onClick={onClose} aria-label="חזרה לקטלוג">
          →
        </button>
        {/* Just the title: the front matter below carries the full details,
            and this bar only has to say which book you are in. */}
        <div className="rd-title">
          <strong>{book.title}</strong>
          {currentFolio && <span className="rd-at">{currentFolio}</span>}
        </div>

        <div className="rd-search">
          <input
            id="rd-search"
            type="search"
            placeholder="חיפוש בספר…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && step(e.shiftKey ? -1 : 1)}
          />
          {query.trim().length > 1 && (
            <span className="rd-count">
              {matches.length === 0 ? 'אין תוצאות' : `${hitIndex + 1}/${matches.length}`}
            </span>
          )}
          {matches.length > 0 && (
            <>
              {/* Words rather than arrows: no ambiguity about which way
                  "forward" points in a right-to-left interface. */}
              <button type="button" className="rd-btn rd-step" onClick={() => step(-1)}>
                הקודם
              </button>
              <button type="button" className="rd-btn rd-step" onClick={() => step(1)}>
                הבא
              </button>
            </>
          )}
        </div>

        <div className="rd-tools">
          <button
            type="button"
            className="rd-btn"
            onClick={() => setSizeIndex((i) => Math.max(0, i - 1))}
            aria-label="הקטנת טקסט"
          >
            א−
          </button>
          <button
            type="button"
            className="rd-btn"
            onClick={() => setSizeIndex((i) => Math.min(SIZES.length - 1, i + 1))}
            aria-label="הגדלת טקסט"
          >
            א+
          </button>
          {entries.length > 0 && (
            <button
              type="button"
              className="rd-btn"
              onClick={() => setShowToc((v) => !v)}
              aria-pressed={showToc}
            >
              תוכן
            </button>
          )}

          {/* One button rather than three: downloading is the rarest thing you
              do while reading, and it was crowding the controls you use most. */}
          <div className="rd-menu-wrap">
            <button
              type="button"
              className="rd-btn rd-download"
              disabled={busy !== null || !doc || !exportable}
              // An edition with a named rights holder may be read here but not
              // handed over as a file.
              title={exportable ? undefined : 'המהדורה הזו מוגנת בזכויות יוצרים ואינה ניתנת להורדה'}
              onClick={() => setMenuOpen((v) => !v)}
              aria-expanded={menuOpen}
            >
              {busy ? '…' : 'הורדה ▾'}
            </button>
            {menuOpen && (
              <ul className="rd-menu">
                {(['pdf', 'docx', 'epub'] as ExportFormat[]).map((f) => (
                  <li key={f}>
                    <button type="button" onClick={() => download(f)}>
                      <span className="rd-menu-name">{FORMAT_LABEL[f]}</span>
                      <span className="rd-menu-hint">{FORMAT_HINT[f]}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </header>

      {status && (
        <div className="rd-status">
          <span>{status}</span>
          {progress !== null && (
            <span
              className="rd-progress"
              role="progressbar"
              aria-valuenow={Math.round(progress * 100)}
            >
              <span style={{ width: `${Math.max(2, progress * 100)}%` }} />
            </span>
          )}
        </div>
      )}

      <div className="rd-body">
        {showToc && entries.length > 0 && (
          <nav className="rd-toc" aria-label="תוכן העניינים">
            <button
              type="button"
              className="rd-toc-close"
              onClick={() => setShowToc(false)}
              aria-label="סגירת התוכן"
            >
              ×
            </button>
            <ol>
              {entries.map((e) => (
                <li
                  key={e.id}
                  ref={e.id === activeEntry ? activeRef : undefined}
                  className={e.id === activeEntry ? 'rd-toc-active' : undefined}
                >
                  <button
                    type="button"
                    aria-current={e.id === activeEntry ? 'true' : undefined}
                    onClick={() => {
                      const at = doc?.blocks.findIndex(
                        (b, bi) => b.kind === 'heading' && `h${bi}` === e.id,
                      );
                      if (at !== undefined && at >= 0) scrollToBlock(at);
                      // Only get out of the way where the drawer covers the
                      // text; on a wide screen you navigate section to section
                      // and closing it every time is a nuisance.
                      if (!wideScreen()) setShowToc(false);
                    }}
                  >
                    <span>{e.text}</span>
                    <span className="rd-folio">{e.label}</span>
                  </button>
                </li>
              ))}
            </ol>
          </nav>
        )}

        <div className="rd-scroll" ref={scrollRef} style={{ fontSize: SIZES[sizeIndex] }}>
          {/* Drawn from the catalogue, so the book identifies itself straight
              away while the text is still on its way. */}
          <header className="rd-front">
            <h1>{book.title}</h1>
            {book.author && <p className="rd-front-author">{book.author}</p>}
            <p className="rd-front-meta">
              {[
                book.place,
                book.year,
                book.category,
                book.subcategory,
                doc ? `${doc.pageCount} עמודים` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
            {/* The library gets its full name and a link, not a facet label:
                these texts are somebody's work and the credit should read like
                one. The caveat below it is the library's own wording. */}
            <p className="rd-front-source">
              {doc ? (
                <a href={doc.attribution.libraryUrl} target="_blank" rel="noreferrer">
                  {doc.attribution.library}
                </a>
              ) : (
                providerLabel(book.provider)
              )}
            </p>
            {doc && <p className="rd-front-note">{doc.attribution.provenance}</p>}
          </header>

          {error && <p className="rd-msg rd-error">{error}</p>}
          {!doc && !error && (
            <p className="rd-msg">
              מוריד את הספר… {ratio > 0 && `${Math.round(ratio * 100)}%`}
            </p>
          )}

          {doc && (
            <article className="rd-text">
              {doc.blocks.map((block, i) => {
                const newPage = block.page !== lastPage;
                if (newPage) lastPage = block.page;
                return (
                  <div
                    key={i}
                    id={`rd-b${i}`}
                    data-block={i}
                    data-folio={block.page}
                    className="rd-block"
                  >
                    {newPage && <span className="rd-pagemark">{blockLabel(block)}</span>}
                    <BlockView block={block} hits={hitsByBlock.get(i) ?? []} />
                  </div>
                );
              })}
              <p className="rd-colophon">
                {doc.alsoFrom?.length ? (
                  <>
                    הספר מורכב מ{doc.alsoFrom.length + 1} מקורות:{' '}
                    {[doc.attribution, ...doc.alsoFrom]
                      .map((a) => `${a.provenance} (${a.license.name})`)
                      .join(' · ')}
                    <br />
                  </>
                ) : null}
                הטקסט באדיבות{' '}
                <a href={doc.attribution.libraryUrl} target="_blank" rel="noreferrer">
                  {doc.attribution.library}
                </a>{' '}
                · רישיון{' '}
                {doc.attribution.license.url ? (
                  <a href={doc.attribution.license.url} target="_blank" rel="noreferrer">
                    {doc.attribution.license.name}
                  </a>
                ) : (
                  doc.attribution.license.name
                )}
                {book.sourceUrl && (
                  <>
                    {' '}
                    · <a href={book.sourceUrl}>הורדת מקור הטקסט</a>
                  </>
                )}
                <br />
                {doc.attribution.provenance}
              </p>
            </article>
          )}
        </div>
      </div>
    </div>
  );
}
