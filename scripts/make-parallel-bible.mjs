/**
 * The Tanakh as one bilingual PDF: the Masoretic text with an English
 * translation under each verse.
 *
 * Deliberately a script rather than a feature. The two pieces worth keeping —
 * pairing a text with a parallel version of itself, and combining several works
 * into one document — live in src/lib/weave.ts, where anything else can use
 * them. What is specific to this job (which books, which translation, in what
 * order) stays here.
 *
 *   node scripts/make-parallel-bible.mjs
 *   node scripts/make-parallel-bible.mjs --limit=2 --out=dist-books/torah.pdf
 *
 * The translation defaults to the Koren Jerusalem Bible (CC-BY-NC on Sefaria).
 * `--english="The Holy Scriptures: A New Translation (JPS 1917)"` is public
 * domain, if the non-commercial clause is inconvenient.
 */
import { build } from 'esbuild';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const API = 'https://www.sefaria.org/api';

const args = new Map(
  process.argv.slice(2).map((a) => {
    const at = a.indexOf('=');
    return at === -1 ? [a, ''] : [a.slice(0, at), a.slice(at + 1)];
  }),
);
const limit = Number(args.get('--limit') ?? 0);
const only = args.get('--only');
const englishOnly = args.has('--english-only');
const english = args.get('--english') || 'The Koren Jerusalem Bible';
const outFile = args.get('--out') || 'dist-books/tanakh-parallel.pdf';

async function loadLib() {
  const entry = join(tmpdir(), `shelf-lib-${Date.now()}.mjs`);
  await build({
    stdin: {
      contents: `export { buildSefariaDoc, ARABIC } from './src/lib/sefariaDoc';
export { weaveParallel, combineDocs } from './src/lib/weave';
export { sefariaAttribution, combinedLicense } from './src/lib/attribution';
export { buildPdf, ENGLISH_LABELS, HEBREW_LABELS } from './src/lib/pdf';`,
      resolveDir: process.cwd(),
      sourcefile: 'entry.ts',
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: entry,
    logLevel: 'error',
  });
  const mod = await import(pathToFileURL(entry).href);
  await rm(entry, { force: true });
  return mod;
}

async function getJson(url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url);
    if (res.ok) return res.json();
    if (res.status === 404) return null;
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  throw new Error(`giving up on ${url}`);
}

/** The books of the Tanakh, in order, as Sefaria refs. */
async function tanakhBooks() {
  const toc = await getJson(`${API}/index/`);
  const tanakh = toc.find((c) => c.category === 'Tanakh');
  if (!tanakh) throw new Error('Tanakh not found in the Sefaria index');
  const out = [];
  const walk = (nodes) => {
    for (const n of nodes ?? []) {
      // Commentary sits under the same tree; only the books themselves here.
      if (n.contents) walk(n.contents);
      else if (n.title && n.categories?.[0] === 'Tanakh') out.push(n.title);
    }
  };
  walk(tanakh.contents);
  return out;
}

/**
 * Run the verses of a chapter together into one paragraph, numbered inline.
 *
 * One block per verse is right for the bilingual edition, where each verse has
 * its translation beneath it. Set on its own, it breaks continuous prose into a
 * column of short lines. Headings still separate chapters.
 */
function flowVerses(blocks) {
  const out = [];
  let current = null;
  for (const b of blocks) {
    if (b.kind !== 'para') {
      out.push(b);
      current = null;
      continue;
    }
    const num = (b.label ?? '').split(':').pop() ?? '';
    const text = b.spans
      .map((s) => s.text)
      .join(' ')
      .trim();
    // The number is its own span so the renderer can set it small, the way a
    // printed Bible does — it is an address, not part of the sentence.
    const parts = num
      ? [{ text: num, bold: false, small: true }, { text, bold: false }]
      : [{ text, bold: false }];
    if (current) {
      current.spans.push(...parts);
    } else {
      current = { kind: 'para', page: b.page, label: b.label, spans: parts };
      out.push(current);
    }
  }
  return out;
}

async function fetchVersion(ref, version) {
  const res = await getJson(`${API}/v3/texts/${encodeURIComponent(ref)}?version=${encodeURIComponent(version)}`);
  const v = res?.versions?.[0];
  if (!v) return null;
  return {
    node: {
      sectionNames: res.sectionNames ?? [],
      addressTypes: res.addressTypes ?? [],
      text: v.text,
    },
    versionTitle: v.versionTitle,
    license: v.license,
  };
}

const {
  buildSefariaDoc,
  ARABIC,
  weaveParallel,
  combineDocs,
  sefariaAttribution,
  combinedLicense,
  buildPdf,
  ENGLISH_LABELS,
  HEBREW_LABELS,
} = await loadLib();

// An English-only volume is numbered in digits and its sections named in
// English; the defaults are Hebrew because that is what the shelf mostly holds.
const sectionNames = englishOnly ? {} : undefined;
const numeral = englishOnly ? ARABIC : undefined;
const labels = englishOnly ? ENGLISH_LABELS : HEBREW_LABELS;

let titles = await tanakhBooks();
if (only) titles = titles.filter((t) => t === only);
if (limit > 0) titles = titles.slice(0, limit);
console.log(`${titles.length} books · translation: ${english}`);

const parts = [];
const sources = new Map();

for (const [i, title] of titles.entries()) {
  process.stdout.write(`  ${String(i + 1).padStart(2)}/${titles.length} ${title.padEnd(22)}`);
  // Sefaria wants language|versionTitle; without the prefix it answers with
  // nothing and the pairing silently finds no partner.
  const [he, en] = await Promise.all([
    fetchVersion(title, 'source'),
    fetchVersion(title, `english|${english}`),
  ]);
  if (!he) {
    console.log('no Hebrew text — skipped');
    continue;
  }

  const heAttr = sefariaAttribution({ versionTitle: he.versionTitle, license: he.license });
  const heDoc = buildSefariaDoc([he.node], heAttr);
  sources.set(heAttr.provenance, heAttr);

  let blocks = heDoc.blocks;
  let paired = 0;
  if (!en) {
    console.log(`no "${english}" for this book — Hebrew only`);
  } else {
    const enAttr = sefariaAttribution({ versionTitle: en.versionTitle, license: en.license });
    if (!enAttr.license.exportable) {
      console.log(`translation is ${enAttr.license.name} — cannot be exported`);
      process.exit(1);
    }
    sources.set(enAttr.provenance, enAttr);
    const enDoc = buildSefariaDoc([en.node], enAttr, sectionNames, numeral);
    if (englishOnly) {
      // The translation stands on its own: no layer, and no Hebrew beneath it.
      blocks = flowVerses(enDoc.blocks);
      paired = enDoc.blocks.length;
      sources.delete(heAttr.provenance);
    } else {
      blocks = weaveParallel(heDoc, enDoc, enAttr.library);
      paired = blocks.length - heDoc.blocks.length;
    }
  }

  parts.push({ title, doc: { ...heDoc, blocks } });
  console.log(`${String(heDoc.blocks.length).padStart(5)} verses  +${paired} translated`);
}

const all = [...sources.values()];
const attribution = englishOnly
  ? {
      ...all[0],
      library: 'Sefaria',
      libraryUrl: 'https://www.sefaria.org',
      about: 'A free library of Jewish texts, offered to the public at no cost.',
      provenance: `Translation: ${english}.`,
      dataLabel: undefined,
      dataUrl: undefined,
      license: combinedLicense(all),
    }
  : {
      ...all[0],
      library: 'ספריא',
      provenance: all.map((a) => a.provenance).join(' · '),
      license: combinedLicense(all),
    };

const doc = combineDocs(parts, attribution);
// The per-part credits are written in Hebrew by sefariaAttribution; in an
// English volume the single English attribution already says it all.
if (englishOnly) doc.alsoFrom = [];
const chars = doc.blocks.reduce((n, b) => n + b.spans.reduce((s, p) => s + p.text.length, 0), 0);
console.log(`\ncombined: ${doc.blocks.length} blocks · ${(chars / 1e6).toFixed(2)}M characters`);
console.log(`licence: ${attribution.license.name}`);

const single = titles.length === 1 ? titles[0] : null;
const book = englishOnly
  ? {
      id: 'sefaria:tanakh-english',
      provider: 'sefaria',
      kind: 'book',
      title: single ?? 'The Hebrew Bible',
      titleEn: null,
      author: null,
      authorEn: null,
      category: 'Bible',
      categoryEn: 'Bible',
      subcategory: english,
      subcategoryEn: english,
      place: null,
      placeEn: null,
      year: null,
      source: 'Sefaria',
      reviewed: true,
      ref: 'Tanakh',
      sourceUrl: 'https://www.sefaria.org/texts/Tanakh',
      key: '',
    }
  : {
  id: 'sefaria:tanakh-parallel',
  provider: 'sefaria',
  kind: 'book',
  title: 'תנ״ך עם תרגום אנגלי',
  titleEn: null,
  author: null,
  authorEn: null,
  category: 'תנ"ך',
  categoryEn: 'Tanakh',
  subcategory: 'מקרא',
  subcategoryEn: 'Bible',
  place: null,
  placeEn: null,
  year: null,
  source: 'ספריא',
  reviewed: true,
  ref: 'Tanakh',
  sourceUrl: 'https://www.sefaria.org/texts/Tanakh',
  key: '',
};

/**
 * Fetched rather than vendored. These are the faces Sefaria serves, and the
 * licence Taamey Frank declares is GPL v2 without a clearly stated font
 * exception — not something to commit into a public repository on a guess.
 * The cache directory is ignored by git.
 */
async function font(name) {
  const path = join('dist-books/fonts', name.split('/').pop());
  try {
    return await readFile(path);
  } catch {
    await mkdir('dist-books/fonts', { recursive: true });
    const res = await fetch(`https://www.sefaria.org/static/fonts/${name}`);
    if (!res.ok) throw new Error(`could not fetch ${name}: ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    await writeFile(path, bytes);
    return bytes;
  }
}

// Cardo alone for an English-only volume — a Latin book has no reason to be set
// in a Hebrew face. Taamey Frank when there is Hebrew: it is what Sefaria sets
// cantillated text in, and its own Latin is a decent serif, which matters
// because Cardo loses most of its glyphs when pdf-lib subsets it alongside a
// second font.
// Taamey Frank for both: Sefaria pairs it with Cardo for the web, but Cardo
// renders only a scattering of its glyphs when pdf-lib makes it a document's
// primary face — it works as a secondary one, which is not a distinction worth
// building on. Taamey Frank's own Latin is a clean serif and is already proven
// through this pipeline.
const fonts = {
  regular: await font('Taamey-Frank/TaameyFrankCLM-Medium.ttf'),
  bold: await font('Taamey-Frank/TaameyFrankCLM-Bold.ttf'),
  hasCantillation: !englishOnly,
};

let last = -1;
const started = Date.now();
const bytes = await buildPdf(
  book,
  doc,
  fonts,
  (ratio) => {
    const pct = Math.floor(ratio * 100);
    if (pct >= last + 10) {
      last = pct;
      process.stdout.write(`
  building PDF ${pct}%`);
    }
  },
  labels,
);

await mkdir('dist-books', { recursive: true });
await writeFile(outFile, bytes);
console.log(
  `\r  ${outFile} — ${(bytes.length / 1e6).toFixed(1)} MB in ${((Date.now() - started) / 1000).toFixed(0)}s`,
);
