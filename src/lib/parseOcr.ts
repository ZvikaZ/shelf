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
  // A marked book carries one paragraph mark per page or more; an unmarked one
  // has a stray handful at most. Below one every other page they cannot be
  // what closes a paragraph, so the page has to be.
  const marks = parsed.reduce(
    (n, p) => n + p.words.filter((w) => w.classes.has('marked-paragraph')).length,
    0,
  );
  const pageIsUnit = marks < parsed.length / 2;
  // With no marks to go on, a book's own "סימן N" is its best structure, and
  // replaces whatever stray heading words the OCR left behind.
  const simanim = pageIsUnit ? findSimanim(parsed.map((p) => p.words)) : new Map<string, Siman>();
  const titleClass = simanim.size ? null : headingClass;
  // A book numbered in several runs repeats every number; a part heading per
  // run is what tells its two `סימן ב` apart.
  const partCount = Math.max(0, ...[...simanim.values()].map((s) => s.part));
  let openPart = 0;

  const blocks: Block[] = [];
  let open: Block | null = null;

  const flush = () => {
    if (open && open.spans.length) blocks.push(open);
    open = null;
  };

  parsed.forEach(({ page, words: ws }, p) => {
    for (let i = 0; i < ws.length; i++) {
      const w = ws[i];
      const startsPara = w.classes.has('marked-paragraph');

      const siman = simanim.get(`${p}:${i}`);
      if (siman) {
        flush();
        if (partCount > 1 && siman.part !== openPart) {
          openPart = siman.part;
          blocks.push({
            kind: 'heading',
            level: 2,
            page,
            spans: [{ text: `חלק ${hebrewNumber(siman.part)}`, bold: false }],
          });
        }
        blocks.push({
          kind: 'heading',
          ...(partCount > 1 && { level: 3 }),
          page,
          spans: [{ text: `סימן ${hebrewNumber(siman.n)}`, bold: false }],
        });
        i += siman.words - 1;
        continue;
      }

      if (titleClass && w.classes.has(titleClass)) {
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
    // and let the next `marked-paragraph` close it. With too few marks there is
    // nothing to close it, so the page itself becomes the unit.
    if (pageIsUnit) flush();
  });
  flush();

  return {
    blocks: numberLongTitles(blocks),
    pageCount: pages.length,
    fidelity,
    citation: 'דף',
    attribution: DICTA_ATTRIBUTION,
  };
}

interface Siman {
  /** Its number in the sequence, which is trusted over what the OCR read. */
  n: number;
  /** Which run of numbers it belongs to, counting from 1; see `findSimanim`. */
  part: number;
  /** How many OCR words the title takes up: `סימן` and its number, or one box. */
  words: number;
}

const LETTER_VALUE: Record<string, number> = Object.fromEntries(
  [...'אבגדהוזחטיכלמנסעפצקרשת'].map((c, i) => [
    c,
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 200, 300, 400][i],
  ]),
);

/** The value of a Hebrew numeral like `קי"ט`, or null if the word is not one. */
function numeral(word: string): number | null {
  const letters = word.replace(/["'׳״.:,]/g, '');
  if (!letters || letters.length > 4) return null;
  const values = [...letters].map((c) => LETTER_VALUE[c]);
  if (values.some((v) => v === undefined)) return null;
  // Written largest first, so `אחד` or `בין` (rising) is a word, not a number.
  if (values.some((v, i) => i > 0 && v > values[i - 1])) return null;
  return values.reduce((a, b) => a + b, 0);
}

/** Each title is at most this far past the last: OCR loses the odd one. */
const MAX_SIMAN_STEP = 5;
/** Shorter chains are chance — a few citations that happen to rise. */
const MIN_SIMANIM = 5;
/**
 * What starting the numbering over costs the chain, in titles: enough that a
 * stray `סימן ב` cannot restart it, little enough that a real part — two or
 * three titles at least — pays its way.
 */
const RESTART_COST = 2;
/** `סי'` is how some books head a responsum, and how most cite one. */
const SIMAN_WORD = /^(סימן|סי['׳])$/;

interface Candidate {
  p: number;
  i: number;
  /** The number as read, or null where the OCR garbled it. */
  n: number | null;
  words: number;
  /** At the top of a page or after a full stop — where a title stands. */
  titlePlace: boolean;
  /** Bold or in a title's place: shaped like a title, not a citation. */
  titleLike: boolean;
}

/**
 * Finds a book's "סימן N" titles, keyed `page:word`.
 *
 * The word occurs hundreds of times in the text — `סימן אחד`, `בין סימן
 * לסימן`, `בש"ך סימן קי"ט` — and what sets the titles apart is that their
 * numbers run in order. The backbone is the longest such run among the
 * occurrences shaped like a title (bold, or after a full stop); a plain one
 * can only fill a hole in it with exactly the number missing there, so a
 * citation never stretches the run. Where a number is still missing, the OCR
 * usually misread it (`סימן שדמ` for שמד, `סימן א'` for ו), and a `סימן`
 * standing in a title's place takes it.
 *
 * Some books number in several runs — Yeshuot Malko goes to נא, then starts
 * again from ב — so the run may also start over, at a cost, and each run is a
 * part of its own.
 */
function findSimanim(pages: Word[][]): Map<string, Siman> {
  const candidates: Candidate[] = [];
  pages.forEach((ws, p) => {
    ws.forEach((w, i) => {
      const parts = w.text.trim().split(/\s+/);
      if (!SIMAN_WORD.test(parts[0])) return;
      // The OCR boxes `סימן ז` as one word as often as two.
      const next = parts[1] ?? ws[i + 1]?.text.trim() ?? '';
      const n = numeral(next);
      // A misread number is still number-shaped; `א)` opens the text.
      const numberShaped = n !== null || /^[א-ת"'׳״]{1,4}$/.test(next);
      const titlePlace = i === 0 || /[:.]$/.test(ws[i - 1].text.trim());
      candidates.push({
        p,
        i,
        n,
        words: parts.length > 1 || !numberShaped ? 1 : 2,
        titlePlace,
        titleLike: titlePlace || w.classes.has('bold'),
      });
    });
  });

  // The backbone: the best run of title-shaped occurrences, each number
  // 1..MAX_SIMAN_STEP past the last, or starting over near the beginning.
  const shaped = candidates.filter((c) => c.titleLike && c.n !== null);
  const opens = (c: Candidate) => (c.n as number) <= MAX_SIMAN_STEP;
  const score = shaped.map((c) => (opens(c) ? 1 : 0));
  const titles = shaped.map((c) => (opens(c) ? 1 : 0));
  const prev = shaped.map(() => -1);
  const restarts = shaped.map(() => false);
  shaped.forEach((c, k) => {
    for (let j = 0; j < k; j++) {
      if (!score[j]) continue;
      const step = (c.n as number) - (shaped[j].n as number);
      const follows = step > 0 && step <= MAX_SIMAN_STEP;
      const restart = !follows && opens(c) && (shaped[j].n as number) >= MIN_SIMANIM;
      const s = score[j] + 1 - (restart ? RESTART_COST : 0);
      if ((follows || restart) && s > score[k]) {
        score[k] = s;
        titles[k] = titles[j] + 1;
        prev[k] = j;
        restarts[k] = restart;
      }
    }
  });
  let end = score.indexOf(Math.max(0, ...score));
  if (end < 0 || titles[end] < MIN_SIMANIM) return new Map();
  const backbone: Candidate[] = [];
  const restartsAt = new Set<Candidate>();
  for (; end >= 0; end = prev[end]) {
    backbone.unshift(shaped[end]);
    if (restarts[end]) restartsAt.add(shaped[end]);
  }

  const found = new Map<string, Siman>();
  let part = 1;
  const take = (c: Candidate, n: number) =>
    found.set(`${c.p}:${c.i}`, { n, part, words: c.words });
  const order = new Map(candidates.map((c, k) => [c, k]));

  // Each stretch between two backbone titles, and before the first, is filled
  // from the occurrences inside it. Past the last there is nothing to bound a
  // plain one: Tzemach Tzedek's closing `לכאורה סימן צד` reads as the next
  // number, but צד there is "side", not 94.
  backbone.forEach((to, k) => {
    const from = backbone[k - 1];
    if (restartsAt.has(to)) part++;
    take(to, to.n as number);
    const floor = from && !restartsAt.has(to) ? (from.n as number) : 0;
    const inside = candidates.slice(from ? (order.get(from) as number) + 1 : 0, order.get(to));
    // Exact numbers first, rising in order below the title that bounds them.
    const exact: Candidate[] = [];
    let n = floor;
    for (const c of inside) {
      if (c.n === null || c.n <= n || c.n >= (to.n as number) || c.n - n > MAX_SIMAN_STEP) continue;
      exact.push(c);
      n = c.n;
    }
    // Then a misread one, in a title's place, takes what is still missing.
    n = floor;
    let e = 0;
    for (const c of inside) {
      const target = exact[e] ? (exact[e].n as number) : (to.n as number);
      if (c === exact[e]) {
        take(c, (n = target));
        e++;
      } else if (c.titlePlace && n + 1 < target && (c.n === null || c.n <= n || c.n >= target)) {
        take(c, ++n);
      }
    }
  });
  return found;
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
