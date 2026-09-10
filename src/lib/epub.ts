import JSZip from 'jszip';
import { FRANK_RUHL_LICENSE, frankRuhlBytes } from '../assets/fonts/frankRuhl';
import { TAAMEY_D_LICENSE, taameyDBytes } from '../assets/fonts/taameyD';
import { hasCantillation } from './cantillation';
import { stripUnsupportedMarks } from './hebrew';
import { blockText } from './parseOcr';
import { headingId, shouldIncludeToc, tocEntries, type TocEntry } from './toc';
import {
  blockLabel,
  usesCitations,
  verseMark,
  type Block,
  type Book,
  type BookDoc,
} from './types';


export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Chapters are split at headings, then capped so no single file is huge. */
const MAX_CHAPTER_CHARS = 120_000;

export interface Chapter {
  title: string;
  blocks: Block[];
}

export function chapterise(book: Book, doc: BookDoc): Chapter[] {
  const sections: Chapter[] = [];
  let current: Chapter | null = null;

  for (const block of doc.blocks) {
    if (block.kind === 'heading') {
      current = { title: blockText(block), blocks: [block] };
      sections.push(current);
      continue;
    }
    if (!current) {
      // Text ahead of the first heading is front matter.
      current = { title: book.title, blocks: [] };
      sections.push(current);
    }
    current.blocks.push(block);
  }
  if (sections.length === 0) sections.push({ title: book.title, blocks: [] });

  // A book with no headings is one enormous section; split it so no single
  // XHTML file is unreadably large on a low-powered reader.
  const capped: Chapter[] = [];
  for (const section of sections) {
    let part: Block[] = [];
    let size = 0;
    let n = 1;
    for (const b of section.blocks) {
      const length = blockText(b).length;
      if (size > 0 && size + length > MAX_CHAPTER_CHARS) {
        capped.push({ title: n === 1 ? section.title : `${section.title} (${n})`, blocks: part });
        part = [];
        size = 0;
        n++;
      }
      part.push(b);
      size += length;
    }
    capped.push({ title: n === 1 ? section.title : `${section.title} (${n})`, blocks: part });
  }
  return capped;
}

// Frank Ruhl (Rafael Frank, 1908) is the face most 20th-century Torah printing
// used, so it is what a reader expects this text to look like. It is *embedded*
// rather than merely requested: naming a font almost nobody has installed just
// falls through to the reader's default modern sans/serif, which is precisely
// the mistake this replaces.
//
// Frank Ruhl Libre has no cantillation glyphs, so an accented text is set in
// Taamey D instead, which carries all thirty-one and positions them correctly
// where a letter takes two. Only one of the two ever travels in a given book,
// and each carries its own licence, which are not the same licence.
const FACES = {
  plain: {
    family: 'Frank Ruhl Libre',
    file: 'FrankRuhlLibre-hebrew.woff2',
    weights: '400 700',
    bytes: frankRuhlBytes,
    license: FRANK_RUHL_LICENSE,
    licenseFile: 'OFL.txt',
    stack: '"Frank Ruhl Libre", "FrankRuehl", "Frank Ruehl CLM", "David", serif',
  },
  taamim: {
    family: 'Taamey D',
    file: 'TaameyD-hebrew.woff2',
    // One weight; a reader synthesises bold where the source asks for it.
    weights: '500',
    bytes: taameyDBytes,
    license: TAAMEY_D_LICENSE,
    licenseFile: 'LICENSE-TaameyD.txt',
    stack: '"Taamey D", "Taamey Frank CLM", "Frank Ruhl Libre", "David", serif',
  },
} as const;

type Face = (typeof FACES)[keyof typeof FACES];

const styleFor = (face: Face) => `@charset "utf-8";
@font-face {
  font-family: "${face.family}";
  font-weight: ${face.weights};
  font-style: normal;
  src: url("fonts/${face.file}") format("woff2");
}
.verse {
  font-size: 0.68em;
  font-weight: 600;
  color: #6b6456;
  vertical-align: 0.35em;
  margin-inline-end: 0.35em;
}
html { direction: rtl; }
body {
  direction: rtl;
  text-align: justify;
  font-family: ${face.stack};
  line-height: 1.7;
  margin: 1em;
}
h1, h2 { text-align: center; line-height: 1.4; page-break-after: avoid; }
h1 { font-size: 1.35em; margin: 1.2em 0 0.8em; }
h2 { font-size: 1.1em; margin: 1.5em 0 0.6em; }
p { margin: 0 0 0.65em; text-indent: 1.2em; }
/* Commentary on the text above it: smaller and set in, as it is in print. */
p.commentary { font-size: 0.88em; margin-inline-end: 1.4em; line-height: 1.5; }
p:first-of-type { text-indent: 0; }
.pagebreak {
  float: left;
  margin-inline-start: 0.5em;
  font-size: 0.7em;
  color: #999;
  unicode-bidi: isolate;
}
.colophon { font-size: 0.85em; color: #444; line-height: 1.6; text-indent: 0; }
.contents { line-height: 2; padding-inline-start: 1.4em; }
.contents a { text-decoration: none; }
.contents .folio { color: #999; font-size: 0.85em; unicode-bidi: isolate; }
`;

const XHTML_OPEN =
  '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" ' +
  'lang="he" xml:lang="he" dir="rtl">';

interface RenderedChapter {
  name: string;
  title: string;
  xhtml: string;
  /** Pages that anchor inside this file, for the EPUB page-list. */
  pages: number[];
  /** Heading anchors landing in this file, for the contents page. */
  anchors: string[];
}

function renderChapter(
  ch: Chapter,
  index: number,
  seenPages: Set<number>,
  ids: Map<Block, string>,
  keepMarks: boolean,
  cited: boolean,
): RenderedChapter {
  const pages: number[] = [];
  const anchors: string[] = [];
  const body = ch.blocks
    .map((b) => {
      // Page anchors keep a scanned edition citable by folio. A text with real
      // citations gets those inline instead, the way the reader sets them.
      let marker = '';
      if (!cited && !seenPages.has(b.page)) {
        seenPages.add(b.page);
        pages.push(b.page);
        marker =
          `<span epub:type="pagebreak" role="doc-pagebreak" id="pg${b.page}" ` +
          `title="${esc(blockLabel(b))}" class="pagebreak">[${esc(blockLabel(b))}]</span>`;
      }
      // Bold that is not a section title is real emphasis in the source and is
      // preserved as <strong>, matching how Dicta renders the page.
      // Te'amim survive only if the embedded face can set them; see ./hebrew.
      const verse = verseMark(b);
      const opener = verse ? `<span class="verse">${esc(verse)}</span>` : '';
      const inner = b.spans
        .map((sp) => {
          const t = esc(keepMarks ? sp.text : stripUnsupportedMarks(sp.text));
          return sp.bold ? `<strong>${t}</strong>` : t;
        })
        .join(' ');
      // A commentary block is set smaller and indented, the way a printed
      // commentary sets itself apart from the text it comments on.
      if (b.kind !== 'heading') {
        const cls = b.layer ? ' class="commentary"' : '';
        return `<p${cls}>${marker}${opener}${inner}</p>`;
      }
      const id = ids.get(b);
      if (id) anchors.push(id);
      return `<h2${id ? ` id="${id}"` : ''}>${marker}${inner}</h2>`;
    })
    .join('\n');

  const xhtml = `<?xml version="1.0" encoding="utf-8"?>
${XHTML_OPEN}
<head><meta charset="utf-8"/><title>${esc(ch.title)}</title>
<link rel="stylesheet" type="text/css" href="style.css"/></head>
<body dir="rtl">
${body}
</body>
</html>`;

  return {
    name: `ch${String(index + 1).padStart(4, '0')}.xhtml`,
    title: ch.title,
    xhtml,
    pages,
    anchors,
  };
}

function titlePage(book: Book, doc: BookDoc): string {
  const at = doc.attribution;
  const lines = [
    book.author ? `<p class="colophon">${esc(book.author)}</p>` : '',
    book.place && book.year ? `<p class="colophon">${esc(book.place)} ${book.year}</p>` : '',
    '<hr/>',
    `<p class="colophon">${esc(book.category)} · ${esc(book.subcategory)} · ${doc.pageCount} עמודים</p>`,
    `<p class="colophon">${esc(at.provenance)}</p>`,
    ...(doc.alsoFrom ?? []).map(
      (a) =>
        `<p class="colophon">${esc(a.provenance)} — ${esc(a.library)}, ${esc(a.license.name)}</p>`,
    ),
    '<hr/>',
    `<p class="colophon"><strong>הטקסט באדיבות <a href="${at.libraryUrl}">${esc(at.library)}</a></strong> — ` +
      `${esc(at.about)}</p>`,
    at.dataUrl && at.dataLabel
      ? `<p class="colophon">מקור הנתונים: <a href="${esc(at.dataUrl)}">${esc(at.dataLabel)}</a></p>`
      : '',
    `<p class="colophon">רישיון הטקסט: ${
      at.license.url
        ? `<a href="${at.license.url}">${esc(at.license.name)}</a>`
        : esc(at.license.name)
    }</p>`,
    '<p class="colophon">גופן: Frank Ruhl Libre (SIL Open Font License 1.1) — ראו fonts/OFL.txt</p>',
  ].filter(Boolean);

  return `<?xml version="1.0" encoding="utf-8"?>
${XHTML_OPEN}
<head><meta charset="utf-8"/><title>${esc(book.title)}</title>
<link rel="stylesheet" type="text/css" href="style.css"/></head>
<body dir="rtl">
<h1>${esc(book.title)}</h1>
${lines.join('\n')}
</body>
</html>`;
}

/** A readable contents page, for readers whose navigation UI is poor or absent. */
function contentsPage(entries: TocEntry[], location: Map<string, string>): string {
  const rows = entries
    .map((e) => {
      const href = `${location.get(e.id) ?? ''}#${e.id}`;
      return `<li><a href="${href}">${esc(e.text)}</a> <span class="folio">${esc(e.label)}</span></li>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="utf-8"?>
${XHTML_OPEN}
<head><meta charset="utf-8"/><title>תוכן העניינים</title>
<link rel="stylesheet" type="text/css" href="style.css"/></head>
<body dir="rtl">
<h1>תוכן העניינים</h1>
<ol class="contents">
${rows}
</ol>
<p class="colophon">המספרים מציינים את מספר העמוד בדפוס המקורי.</p>
</body>
</html>`;
}

export async function buildEpub(book: Book, doc: BookDoc): Promise<Uint8Array> {
  const seenPages = new Set<number>();

  // One face travels with the book, chosen by whether the text is accented —
  // and the accents are kept only because that face can set them.
  const accented = hasCantillation(doc);
  const cited = usesCitations(doc);
  const face = accented ? FACES.taamim : FACES.plain;

  // Anchor ids are keyed on the block objects, which chapterise preserves.
  const ids = new Map<Block, string>();
  doc.blocks.forEach((b, i) => {
    if (b.kind === 'heading') ids.set(b, headingId(i));
  });

  const chapters = chapterise(book, doc).map((ch, i) =>
    renderChapter(ch, i, seenPages, ids, accented, cited),
  );

  const entries = tocEntries(doc);
  const withContents = shouldIncludeToc(entries);
  const location = new Map<string, string>();
  for (const ch of chapters) for (const a of ch.anchors) location.set(a, ch.name);

  const zip = new JSZip();
  // `mimetype` must be the first entry and stored uncompressed.
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles>
<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
</rootfiles>
</container>`,
  );

  const oebps = zip.folder('OEBPS')!;
  oebps.file('style.css', styleFor(face));
  oebps.file(`fonts/${face.file}`, face.bytes());
  // The OFL requires the licence travel with the font.
  oebps.file(`fonts/${face.licenseFile}`, face.license);
  oebps.file('title.xhtml', titlePage(book, doc));
  if (withContents) oebps.file('contents.xhtml', contentsPage(entries, location));
  for (const ch of chapters) oebps.file(ch.name, ch.xhtml);

  const uid = `urn:book:${book.id}`;
  const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

  const manifest = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
    '<item id="css" href="style.css" media-type="text/css"/>',
    `<item id="font" href="fonts/${face.file}" media-type="font/woff2"/>`,
    '<item id="title" href="title.xhtml" media-type="application/xhtml+xml"/>',
    ...(withContents
      ? ['<item id="contents" href="contents.xhtml" media-type="application/xhtml+xml"/>']
      : []),
    ...chapters.map((c, i) => `<item id="c${i}" href="${c.name}" media-type="application/xhtml+xml"/>`),
  ].join('\n');

  const spine = [
    '<itemref idref="title"/>',
    ...(withContents ? ['<itemref idref="contents"/>'] : []),
    ...chapters.map((_, i) => `<itemref idref="c${i}"/>`),
  ].join('\n');

  oebps.file(
    'content.opf',
    `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xml:lang="he" dir="rtl">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="uid">${uid}</dc:identifier>
<dc:title>${esc(book.title)}</dc:title>
<dc:language>he</dc:language>
${book.author ? `<dc:creator>${esc(book.author)}</dc:creator>` : ''}
<dc:publisher>${esc(doc.attribution.library)}</dc:publisher>
<dc:source>${esc(book.sourceUrl ?? book.ref)}</dc:source>
<dc:rights>${esc(doc.attribution.license.name)}${
  doc.attribution.license.url ? ` — ${doc.attribution.license.url}` : ''
}</dc:rights>
${book.year ? `<dc:date>${book.year}</dc:date>` : ''}
<meta property="dcterms:modified">${modified}</meta>
</metadata>
<manifest>
${manifest}
</manifest>
<spine toc="ncx" page-progression-direction="rtl">
${spine}
</spine>
</package>`,
  );

  const toc = chapters.map((c) => `<li><a href="${c.name}">${esc(c.title)}</a></li>`).join('\n');
  const pageList = chapters
    .flatMap((c) => c.pages.map((p) => `<li><a href="${c.name}#pg${p}">${p}</a></li>`))
    .join('\n');

  oebps.file(
    'nav.xhtml',
    `<?xml version="1.0" encoding="utf-8"?>
${XHTML_OPEN}
<head><meta charset="utf-8"/><title>תוכן העניינים</title></head>
<body dir="rtl">
<nav epub:type="toc" id="toc"><h1>תוכן העניינים</h1>
<ol>
<li><a href="title.xhtml">${esc(book.title)}</a></li>
${withContents ? '<li><a href="contents.xhtml">תוכן העניינים</a></li>' : ''}
${toc}
</ol>
</nav>
<nav epub:type="page-list" id="page-list" hidden="hidden"><h1>עמודים</h1>
<ol>
${pageList}
</ol>
</nav>
</body>
</html>`,
  );

  const navPoints = chapters
    .map(
      (c, i) =>
        `<navPoint id="n${i}" playOrder="${i + 1}"><navLabel><text>${esc(c.title)}</text></navLabel>` +
        `<content src="${c.name}"/></navPoint>`,
    )
    .join('\n');

  oebps.file(
    'toc.ncx',
    `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="he" dir="rtl">
<head><meta name="dtb:uid" content="${uid}"/></head>
<docTitle><text>${esc(book.title)}</text></docTitle>
<navMap>
${navPoints}
</navMap>
</ncx>`,
  );

  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
