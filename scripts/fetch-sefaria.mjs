// Pulls the Sefaria catalogue, normalises it into the same shape as the Dicta
// one, and vendors it into public/.
// Run: npm run fetch:sefaria
import { writeFile, mkdir } from 'node:fs/promises';

const API = 'https://www.sefaria.org/api';

// Hebrew points/accents plus the geresh/gershayim variants that break naive
// matching. Same rule the Dicta script uses, so one search box serves both.
const NIKUD = /[֑-ׇ]/g;
const MARKS = /[׳״"'`‘’“”]/g;

export function normalise(value) {
  return (value ?? '')
    .replace(NIKUD, '')
    .replace(MARKS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * The index tree mixes categories (which have `contents`) with book entries
 * (which have `title`). Only the leaves are books.
 */
function leaves(node, out = []) {
  if (Array.isArray(node)) {
    for (const child of node) leaves(child, out);
  } else if (node?.contents) {
    leaves(node.contents, out);
  } else if (node?.title) {
    out.push(node);
  }
  return out;
}

/**
 * `dependence` marks a work written on another one — a commentary or a targum;
 * `hidden` marks entries Sefaria keeps out of its own table of contents.
 *
 * Both kinds are catalogued, but they are not the same object. A standalone
 * work needs its author and date fetched per title; a commentary carries
 * everything useful in the bulk index already, and is read woven into the text
 * it comments on, so it also needs the ref of that text.
 */
function isStandalone(entry) {
  return !entry.dependence && !entry.hidden;
}

function isCommentary(entry) {
  // Without a base text there is nothing to weave it into, so it would be a
  // book of disembodied comments. 73 entries are in that state.
  return Boolean(entry.dependence) && !entry.hidden && Boolean(entry.base_text_titles?.length);
}

/** Sefaria returns 504s on cold refs often enough to matter over 1,000 calls. */
async function getJson(url, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
      if (i >= attempts) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (i >= attempts) throw err;
    }
    await new Promise((r) => setTimeout(r, 400 * i));
  }
}

/** Bounded concurrency: polite to the API, and fast enough for a CI job. */
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Composition date if known, publication date otherwise. Sefaria gives an
 * array — a single year, or a [from, to] range for works dated loosely — and
 * negative numbers for BCE.
 */
function toYear(index) {
  const raw = index.compDate ?? index.pubDate;
  const n = Array.isArray(raw) ? raw[0] : raw;
  return Number.isFinite(n) ? n : null;
}

function place(index) {
  return index.compPlaceString?.he || index.pubPlaceString?.he || null;
}

function placeEn(index) {
  return index.compPlace || index.pubPlace || null;
}

const catalogue = await getJson(`${API}/index/`);
const all = leaves(catalogue);
const entries = all.filter(isStandalone);
const commentaries = all.filter(isCommentary);
console.log(
  `${all.length} titles: ${entries.length} standalone works, ${commentaries.length} commentaries`,
);

// The index tree carries no author, year or place — that lives only on the
// per-title endpoint, so this is one request per book.
let done = 0;
const failures = [];
const details = await pool(entries, 8, async (entry) => {
  try {
    const index = await getJson(`${API}/v2/index/${encodeURIComponent(entry.title)}`);
    return index;
  } catch (err) {
    failures.push(`${entry.title}: ${err.message}`);
    return null;
  } finally {
    if (++done % 100 === 0) process.stdout.write(`  ${done}/${entries.length}\n`);
  }
});

// A handful of titles carry no `heCategories` at all, which would leave an
// English name sitting in a Hebrew facet list. Every category is translated on
// some other book, so the corpus translates itself.
const heByEn = new Map();
for (let i = 0; i < entries.length; i++) {
  const cats = entries[i].categories ?? [];
  const heCats = details[i]?.heCategories ?? [];
  cats.forEach((en, depth) => {
    if (heCats[depth] && !heByEn.has(en)) heByEn.set(en, heCats[depth]);
  });
}

const books = entries.map((entry, i) => {
  const index = details[i] ?? {};
  const author = index.authors?.[0] ?? null;
  const cats = entry.categories ?? [];
  const heCats = index.heCategories ?? [];
  const he = (depth) => heCats[depth] ?? (cats[depth] ? heByEn.get(cats[depth]) : undefined);
  // A single-category work (Tanakh, Talmud) repeats its category as the
  // subcategory, which is what the Dicta feed does for the same case.
  const category = he(0) ?? cats[0] ?? '';
  const subcategory = he(1) ?? category;

  return {
    id: `sefaria:${entry.title}`,
    provider: 'sefaria',
    kind: 'book',
    // The API ref, which is what the loader asks for.
    ref: entry.title,
    sourceUrl: `https://www.sefaria.org/${encodeURIComponent(entry.title.replace(/ /g, '_'))}`,
    title: entry.heTitle,
    titleEn: entry.title,
    author: author?.he?.trim() || null,
    authorEn: author?.en?.trim() || null,
    category,
    categoryEn: cats[0] ?? '',
    subcategory,
    subcategoryEn: cats[1] ?? cats[0] ?? '',
    place: place(index),
    placeEn: placeEn(index),
    year: toYear(index),
    source: 'Sefaria',
    reviewed: true,
    key: normalise(
      [entry.heTitle, entry.title, author?.he, author?.en, place(index)].join(' '),
    ),
  };
});

/**
 * A commentary is built entirely from the bulk index: `heCommentator` is its
 * author, and its category comes from the same English name the standalone
 * works translate, so no per-title request is needed for any of the 5,400.
 */
const commentaryBooks = commentaries.map((entry) => {
  const cats = entry.categories ?? [];
  const author = entry.heCommentator || entry.heCollectiveTitle || null;
  return {
    id: `sefaria:${entry.title}`,
    provider: 'sefaria',
    kind: 'commentary',
    ref: entry.title,
    // The work it comments on, woven into it when the book is opened.
    baseRef: entry.base_text_titles[0],
    sourceUrl: `https://www.sefaria.org/${encodeURIComponent(entry.title.replace(/ /g, '_'))}`,
    title: entry.heTitle,
    titleEn: entry.title,
    author,
    authorEn: entry.commentator || entry.collectiveTitle || null,
    category: heByEn.get(cats[0]) ?? cats[0] ?? '',
    categoryEn: cats[0] ?? '',
    // The commentator, which is how anyone browsing a shelf of commentaries
    // actually narrows it — far more use than "Acharonim on Tanakh".
    subcategory: entry.heCollectiveTitle || entry.heCommentator || '',
    subcategoryEn: entry.collectiveTitle || entry.commentator || '',
    place: null,
    placeEn: null,
    year: null,
    source: 'Sefaria',
    reviewed: true,
    key: normalise([entry.heTitle, entry.title, author, entry.commentator].join(' ')),
  };
});

books.push(...commentaryBooks);

const byCount = (a, b) => b[1] - a[1];
const tally = (fn) => {
  const m = new Map();
  for (const b of books) {
    const k = fn(b);
    if (k) m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort(byCount).map(([name, count]) => ({ name, count }));
};

const years = books.map((b) => b.year).filter((y) => y !== null);
const facets = {
  categories: tally((b) => b.category),
  subcategories: tally((b) => b.subcategory),
  yearRange: [Math.min(...years), Math.max(...years)],
  total: books.length,
  fetchedAt: new Date().toISOString().slice(0, 10),
};

await mkdir('public', { recursive: true });

// Commentaries are 83% of this shelf and most visitors never open one, so they
// go in their own file. The main catalogue records that they exist and how
// many, which is enough for the app to offer them and fetch them on demand.
const COMMENTARY_FILE = 'books-sefaria-commentaries.json';
const shelf = books.filter((b) => b.kind !== 'commentary');
const commentaries = books.filter((b) => b.kind === 'commentary');

await writeFile(
  'public/books-sefaria.json',
  JSON.stringify({
    facets: { ...facets, total: shelf.length },
    books: shelf,
    deferred: commentaries.length
      ? [{ file: COMMENTARY_FILE, kind: 'commentary', count: commentaries.length }]
      : [],
  }),
);
await writeFile(
  `public/${COMMENTARY_FILE}`,
  JSON.stringify({
    facets: { ...facets, total: commentaries.length },
    books: commentaries,
  }),
);

const have = (fn) => books.filter(fn).length;
console.log(
  `Wrote ${books.length} entries (${entries.length} books, ${commentaryBooks.length} ` +
    `commentaries) · ${facets.categories.length} categories · ` +
    `${facets.subcategories.length} subcategories · years ${facets.yearRange.join('–')}`,
);
console.log(
  `  author ${have((b) => b.author)} · year ${have((b) => b.year)} · place ${have((b) => b.place)}`,
);
if (failures.length) console.log(`  ${failures.length} lookups failed:`, failures.slice(0, 5));
