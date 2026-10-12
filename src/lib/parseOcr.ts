import { DICTA_ATTRIBUTION } from './attribution';
import { hebrewNumber } from './sefariaDoc';
import type { Block, BookDoc, Fidelity, Span } from './types';

// The OCR pages are machine-generated: one <span> per word, no newlines, no
// nesting. A regex beats DOMParser here because this also runs in a Worker,
// where there is no DOM at all.
const SPAN = /<span(?:\s+class="([^"]*)")?\s*>([^<]*)<\/span>/g;
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decode(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const cp =
        code[1] === 'x' || code[1] === 'X'
          ? Number.parseInt(code.slice(2), 16)
          : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

interface Word {
  text: string;
  classes: Set<string>;
}

function words(html: string): Word[] {
  const out: Word[] = [];
  SPAN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SPAN.exec(html)) !== null) {
    const text = decode(m[2]);
    if (!text.trim()) continue; // the generator emits a spacer span between words
    out.push({ text, classes: new Set(m[1] ? m[1].split(/\s+/) : []) });
  }
  return out;
}

/** Page number embedded in e.g. `alfeimenashe-050__ocr_data.html`. */
export function pageNumber(fileName: string, fallback: number): number {
  const m = /-(\d+)(?:__|\.)/.exec(fileName);
  return m ? Number.parseInt(m[1], 10) : fallback;
}

export function blockText(block: Block): string {
  return block.spans.map((s) => s.text).join(' ');
}

/** Longer bold runs are emphasis on a quoted passage, not a section title. */
const MAX_HEADING_WORDS = 40;

/**
 * Past this a title reads as a paragraph in the contents. Some books open each
 * sermon with a dedication (who preached it, where, on what date) rather than
 * a name; those are numbered instead, the way Sefaria numbers its דרוש א, ב.
 */
const MAX_CONTENTS_WORDS = 12;

/** A run of punctuation is OCR noise, not a section title. */
const HAS_LETTER = /\p{L}/u;

function appendSpan(spans: Span[], text: string, bold: boolean): void {
  const last = spans[spans.length - 1];
  if (last && last.bold === bold) last.text += ' ' + text;
  else spans.push({ text, bold });
}

/**
 * Fold the per-page word streams into a linear block list.
 *
 * Structural markup is optional in this corpus: some books carry `heading`,
 * most carry only `bold`/`marked-paragraph`, and a few carry nothing at all.
 * We pick the best tier available so every book still exports.
 */
export function buildDoc(pages: { name: string; html: string }[]): BookDoc {
  const parsed = pages.map((p, i) => ({ page: pageNumber(p.name, i + 1), words: words(p.html) }));

  const has = (cls: string) => parsed.some((p) => p.words.some((w) => w.classes.has(cls)));
  const fidelity: Fidelity = has('heading') ? 'heading' : has('bold') ? 'bold' : 'pages';
  const headingClass = fidelity === 'heading' ? 'heading' : 'bold';

  const blocks: Block[] = [];
  let open: Block | null = null;

  const flush = () => {
    if (open && open.spans.length) blocks.push(open);
    open = null;
  };

  for (const { page, words: ws } of parsed) {
    for (let i = 0; i < ws.length; i++) {
      const w = ws[i];
      const startsPara = w.classes.has('marked-paragraph');

      if (w.classes.has(headingClass)) {
        // Measure the whole run before deciding what it is. A paragraph mark
        // ends it even mid-run: a title can run straight into a paragraph that
        // opens in bold, and the mark is all that separates the two.
        let end = i + 1;
        while (
          end < ws.length &&
          ws[end].classes.has(headingClass) &&
          !ws[end].classes.has('marked-paragraph')
        )
          end++;
        const run = ws.slice(i, end);

        // A section title is delimited on its RIGHT by a paragraph break. That
        // is the reliable signal: these books set run-in headings, where the
        // title closes the previous paragraph rather than opening its own, so
        // requiring it to start a paragraph misses most of them.
        const breakAfter = end >= ws.length || ws[end].classes.has('marked-paragraph');
        const runText = run.map((r) => r.text).join(' ');
        const isHeading =
          HAS_LETTER.test(runText) &&
          (fidelity === 'heading' ||
          (breakAfter &&
            run.length <= MAX_HEADING_WORDS &&
            // At a page edge there is no following word to confirm the break,
            // so only trust it when the run also opens a paragraph.
            (end < ws.length || startsPara || i === 0)));

        if (isHeading) {
          flush();
          blocks.push({ kind: 'heading', page, spans: [{ text: runText, bold: false }] });
          i = end - 1;
          continue;
        }

        // Not a title — keep it as emphasis instead of flattening it away.
        if (startsPara) flush();
        if (!open) open = { kind: 'para', page, spans: [] };
        for (const r of run) appendSpan(open.spans, r.text, true);
        i = end - 1;
        continue;
      }

      if (startsPara) flush();
      if (!open) open = { kind: 'para', page, spans: [] };
      appendSpan(open.spans, w.text, false);
    }
    // Paragraphs run across page boundaries, so we normally keep the block open
    // and let the next `marked-paragraph` close it. With no markup at all there
    // is nothing to close it, so the page itself becomes the unit.
    if (fidelity === 'pages') flush();
  }
  flush();

  return {
    blocks: numberLongTitles(blocks),
    pageCount: pages.length,
    fidelity,
    citation: 'דף',
    attribution: DICTA_ATTRIBUTION,
  };
}

/**
 * A book that routinely dedicates its sermons instead of naming them gets
 * numbered sections, each title kept in bold as the section's opening line; a
 * contents that mixes letters with prose is harder to scan than either. In a
 * book whose titles are short, a lone long one is more likely a bold passage,
 * so it stays text — renumbering every well-named section for its sake would
 * lose more than it gains.
 */
const NUMBER_WHEN_LONG_SHARE = 0.1;

function numberLongTitles(blocks: Block[]): Block[] {
  const isLong = (b: Block) =>
    b.kind === 'heading' && blockText(b).split(/\s+/).length > MAX_CONTENTS_WORDS;
  const headings = blocks.filter((b) => b.kind === 'heading').length;
  const long = blocks.filter(isLong).length;
  if (long === 0) return blocks;
  const numbered = long / headings > NUMBER_WHEN_LONG_SHARE;
  const asText = (b: Block): Block => ({
    kind: 'para',
    page: b.page,
    spans: [{ text: blockText(b), bold: true }],
  });
  let n = 0;
  return blocks.flatMap((b) => {
    if (b.kind !== 'heading') return [b];
    if (numbered) return [{ ...b, spans: [{ text: hebrewNumber(++n), bold: false }] }, asText(b)];
    return isLong(b) ? [asText(b)] : [b];
  });
}
