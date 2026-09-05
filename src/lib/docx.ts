import {
  AlignmentType,
  Document,
  FrameAnchorType,
  FrameWrap,
  Footer,
  Header,
  HeadingLevel,
  LineRuleType,
  PageBreak,
  PageNumber,
  Packer,
  Paragraph,
  TextRun,
} from 'docx';
import { stripUnsupportedMarks } from './hebrew';
import { shouldIncludeToc, tocEntries } from './toc';
import { blockLabel, type Book, type BookDoc, type Span } from './types';


// Word picks the font for Hebrew from the *complex script* slot (`cs`), not
// `ascii`, so both are set — otherwise the run silently falls back to Calibri.
// FrankRuehl ships with Windows, which is where these files will mostly open.
const FONT = { ascii: 'FrankRuehl', hAnsi: 'FrankRuehl', cs: 'FrankRuehl' } as const;

const INK = '000000';
const GREY = '808080';

// Half-points.
const BODY_SIZE = 23;
const HEAD_SIZE = 26;
const SMALL_SIZE = 18;

// Every paragraph needs `bidirectional`, otherwise Word lays the text out
// left-to-right and strands the punctuation on the wrong side of the line.
function rtl(
  content: string | Span[],
  opts: { heading?: boolean; small?: boolean; indent?: boolean; inset?: boolean } = {},
): Paragraph {
  const spans: Span[] = typeof content === 'string' ? [{ text: content, bold: false }] : content;
  const size = opts.heading ? HEAD_SIZE : opts.small ? SMALL_SIZE : BODY_SIZE;

  return new Paragraph({
    bidirectional: true,
    alignment: opts.heading ? AlignmentType.CENTER : AlignmentType.JUSTIFIED,
    // The style carries the look; the outline level only feeds Word's
    // navigation pane and the generated bookmarks.
    heading: opts.heading ? HeadingLevel.HEADING_2 : undefined,
    style: opts.heading ? 'SectionHeading' : undefined,
    spacing: opts.heading
      ? { before: 320, after: 140, line: 280, lineRule: LineRuleType.AUTO }
      : { after: 0, line: 320, lineRule: LineRuleType.AUTO },
    indent: opts.inset
      ? { start: 480, firstLine: opts.indent ? 340 : 0 }
      : opts.indent
        ? { firstLine: 340 }
        : undefined,
    children: spans.map(
      (s, i) =>
        new TextRun({
          // Runs were split on style, so restore the separating space.
          // FrankRuehl has no cantillation glyphs either; see ./hebrew.
          text: stripUnsupportedMarks(i === 0 ? s.text : ' ' + s.text),
          rightToLeft: true,
          font: FONT,
          size,
          color: INK,
          bold: opts.heading || s.bold,
        }),
    ),
  });
}

/**
 * The scanned folio, floated into the outer margin beside the line it begins
 * on — the same reference mark the PDF carries.
 *
 * A framed paragraph is Word's mechanism for marginal notes: anchored to the
 * page horizontally it sits inside the left margin (the outer edge in a
 * right-to-left book), and anchored to the text vertically it travels with the
 * paragraph it marks, however Word repaginates.
 */
function folioMark(folio: string): Paragraph {
  return new Paragraph({
    frame: {
      type: 'absolute',
      position: { x: 420, y: 0 },
      width: 520,
      height: 260,
      anchor: { horizontal: FrameAnchorType.PAGE, vertical: FrameAnchorType.TEXT },
      wrap: FrameWrap.NONE,
    },
    alignment: AlignmentType.LEFT,
    spacing: { before: 0, after: 0 },
    children: [
      new TextRun({ text: String(folio), font: FONT, size: 15, color: GREY }),
    ],
  });
}

export async function buildDocx(book: Book, doc: BookDoc): Promise<Uint8Array> {
  const front: Paragraph[] = [
    new Paragraph({
      bidirectional: true,
      alignment: AlignmentType.CENTER,
      spacing: { before: 2400, after: 360 },
      children: [
        new TextRun({
          text: book.title,
          rightToLeft: true,
          font: FONT,
          size: 44,
          bold: true,
          color: INK,
        }),
      ],
    }),
  ];
  if (book.author) {
    front.push(
      new Paragraph({
        bidirectional: true,
        alignment: AlignmentType.CENTER,
        spacing: { after: 120 },
        children: [
          new TextRun({ text: book.author, rightToLeft: true, font: FONT, size: 26, color: INK }),
        ],
      }),
    );
  }
  if (book.place && book.year) {
    front.push(rtl(`${book.place} ${book.year}`, { small: true }));
  }
  front.push(
    rtl(`${book.category} · ${book.subcategory} · ${doc.pageCount} עמודים`, { small: true }),
    rtl(doc.attribution.provenance, { small: true }),
    ...(doc.alsoFrom ?? []).map((a) =>
      rtl(`${a.provenance} — ${a.library}, ${a.license.name}`, { small: true }),
    ),
    rtl(
      `הטקסט באדיבות ${doc.attribution.library} (${doc.attribution.libraryUrl}) — ` +
        doc.attribution.about,
      { small: true },
    ),
    ...(doc.attribution.dataLabel && doc.attribution.dataUrl
      ? [
          rtl(`מקור הנתונים: ${doc.attribution.dataLabel} — ${doc.attribution.dataUrl}`, {
            small: true,
          }),
        ]
      : []),
    rtl(
      `רישיון: ${doc.attribution.license.name}` +
        (doc.attribution.license.url ? ` — ${doc.attribution.license.url}` : ''),
      { small: true },
    ),
    new Paragraph({ children: [new PageBreak()] }),
  );

  // Word has no reader-supplied navigation, so the contents page is written
  // into the document. Folio numbers are the printed ones from the scan, which
  // stay meaningful regardless of how Word repaginates.
  const entries = tocEntries(doc);
  const contents: Paragraph[] = [];
  if (shouldIncludeToc(entries)) {
    contents.push(rtl('תוכן העניינים', { heading: true }));
    for (const e of entries) {
      contents.push(
        new Paragraph({
          bidirectional: true,
          alignment: AlignmentType.START,
          spacing: { after: 40 },
          children: [
            new TextRun({ text: e.text, rightToLeft: true, font: FONT, size: 21, color: INK }),
            new TextRun({
              text: `  ${e.label}`,
              rightToLeft: true,
              font: FONT,
              size: SMALL_SIZE,
              color: GREY,
            }),
          ],
        }),
      );
    }
    contents.push(new Paragraph({ children: [new PageBreak()] }));
  }

  const seenFolios = new Set<number>();
  const body: Paragraph[] = [];
  for (const b of doc.blocks) {
    if (!seenFolios.has(b.page)) {
      seenFolios.add(b.page);
      body.push(folioMark(blockLabel(b)));
    }
    body.push(
      rtl(b.spans, {
        heading: b.kind === 'heading',
        indent: b.kind === 'para',
        // Commentary is set smaller than the text it comments on.
        small: Boolean(b.layer),
        inset: Boolean(b.layer),
      }),
    );
  }

  const document = new Document({
    creator: book.author ?? 'Dicta',
    title: book.title,
    description: `${book.category} · ${book.subcategory}`,
    styles: {
      default: {
        document: { run: { font: FONT, size: BODY_SIZE, color: INK } },
      },
      // Word's built-in Heading styles are blue Calibri Light — utterly wrong
      // for a Torah text. Overriding the style (rather than avoiding headings)
      // keeps the outline level, so Word's navigation pane still works.
      paragraphStyles: [
        {
          id: 'SectionHeading',
          name: 'Section Heading',
          basedOn: 'Normal',
          next: 'Normal',
          quickFormat: true,
          run: { font: FONT, size: HEAD_SIZE, bold: true, color: INK, rightToLeft: true },
          paragraph: { alignment: AlignmentType.CENTER, spacing: { before: 320, after: 140 } },
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            margin: { top: 1200, bottom: 1100, left: 1250, right: 1250 },
          },
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                bidirectional: true,
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({
                    text: book.title,
                    rightToLeft: true,
                    font: FONT,
                    size: 17,
                    color: GREY,
                  }),
                ],
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({
                    children: [PageNumber.CURRENT],
                    font: FONT,
                    size: SMALL_SIZE,
                    color: GREY,
                  }),
                ],
              }),
            ],
          }),
        },
        children: [...front, ...contents, ...body],
      },
    ],
  });

  // Neither Packer.toBuffer (needs Node's Buffer, which Vite does not polyfill)
  // nor Packer.toBlob (needs a complete Blob implementation) works everywhere.
  // Base64 depends on nothing but atob, so one path serves browser and tests.
  const base64 = await Packer.toBase64String(document);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
