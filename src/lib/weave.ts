import type { Block, BookDoc } from './types';

/**
 * Weave a commentary into the text it comments on.
 *
 * A commentary's structure is its base text's plus one level: where a verse of
 * שיר השירים is `ח:ד`, the Malbim's comments on it are `ח:ד:א`, `ח:ד:ב`. So the
 * citation label is the join key, and a comment belongs under the base block
 * whose label is its own with the last address dropped. Nothing here needs
 * Sefaria's `base_text_mapping`, which is absent on 2,269 of them anyway.
 *
 * The commentary leads: this is the Malbim's book, with the verses printed in
 * it the way a printed commentary sets them, not the other way round. So the
 * base text's own headings are kept and its verses carry the comments beneath
 * them, and anything the commentary says about a verse that does not exist is
 * appended rather than dropped.
 */
export function weaveCommentary(base: BookDoc, commentary: BookDoc): Block[] {
  const comments = new Map<string, Block[]>();
  const loose: Block[] = [];

  for (const block of commentary.blocks) {
    if (block.kind !== 'para') continue;
    const label = block.label ?? '';
    const parent = label.split(':').slice(0, -1).join(':');
    if (!parent) {
      loose.push(block);
      continue;
    }
    const list = comments.get(parent);
    if (list) list.push(block);
    else comments.set(parent, [block]);
  }

  const woven: Block[] = [];
  const used = new Set<string>();

  for (const block of base.blocks) {
    woven.push(block);
    const label = block.label ?? String(block.page);
    const on = comments.get(label);
    if (!on) continue;
    used.add(label);
    // Marked as commentary so the reader can indent it and the exporters can
    // set it smaller, the way a printed edition distinguishes the two.
    for (const c of on) woven.push({ ...c, layer: commentary.attribution.library });
  }

  // A comment on a verse the base edition does not carry would otherwise
  // vanish silently; keep it rather than lose the commentator's words.
  for (const [label, list] of comments) {
    if (used.has(label)) continue;
    for (const c of list) woven.push({ ...c, layer: commentary.attribution.library });
  }
  woven.push(...loose);

  return woven;
}

/**
 * Pair a text with a parallel version of itself — a translation.
 *
 * Distinct from `weaveCommentary`, which joins on the *parent* label because a
 * comment sits one address deeper than the verse it discusses. A translation
 * shares the verse's own label exactly, so the join is on equality. Sefaria
 * returns matching unit counts for the two, which is what makes this reliable:
 * Genesis is 1,533 verses in both the Masoretic text and the Koren translation.
 *
 * The base text leads and the parallel follows it, marked as a layer so the
 * renderers set it apart the way they already do for commentary.
 */
export function weaveParallel(base: BookDoc, parallel: BookDoc, layer: string): Block[] {
  const byLabel = new Map<string, Block[]>();
  for (const block of parallel.blocks) {
    if (block.kind !== 'para' || !block.label) continue;
    const list = byLabel.get(block.label);
    if (list) list.push(block);
    else byLabel.set(block.label, [block]);
  }

  const woven: Block[] = [];
  for (const block of base.blocks) {
    woven.push(block);
    const label = block.label;
    if (!label) continue;
    for (const match of byLabel.get(label) ?? []) woven.push({ ...match, layer });
    byLabel.delete(label);
  }

  // A verse the base edition numbers differently would otherwise be dropped.
  for (const list of byLabel.values()) {
    for (const match of list) woven.push({ ...match, layer });
  }
  return woven;
}

/**
 * Several works as one document — a Tanakh in one file rather than 39.
 *
 * Each part gets a heading, and its citation slots are shifted to continue
 * from the last, since `page` addresses a block for links and scroll restore
 * and has to keep increasing across the whole document.
 */
export function combineDocs(
  parts: { title: string; doc: BookDoc; section?: string }[],
  attribution: BookDoc['attribution'],
): BookDoc {
  const blocks: Block[] = [];
  let offset = 0;
  let openSection: string | undefined;

  for (const { title, doc, section } of parts) {
    const highest = doc.blocks.reduce((n, b) => Math.max(n, b.page), 0);
    // A section heading only where the parts are grouped, and only when the
    // group changes — Torah, then Prophets, then Writings.
    if (section && section !== openSection) {
      openSection = section;
      blocks.push({
        kind: 'heading',
        level: 1,
        page: offset + 1,
        spans: [{ text: section, bold: false }],
      });
    }
    blocks.push({
      kind: 'heading',
      level: 2,
      page: offset + 1,
      spans: [{ text: title, bold: false }],
    });
    for (const b of doc.blocks) blocks.push({ ...b, page: b.page + offset });
    offset += highest + 1;
  }

  // Every distinct source credited, so the colophon names them all.
  const seen = new Map<string, BookDoc['attribution']>();
  for (const { doc } of parts) {
    for (const a of [doc.attribution, ...(doc.alsoFrom ?? [])]) {
      if (a.library !== attribution.library || a.provenance !== attribution.provenance) {
        seen.set(`${a.library}|${a.provenance}`, a);
      }
    }
  }

  return {
    blocks,
    pageCount: offset,
    fidelity: 'heading',
    attribution,
    alsoFrom: [...seen.values()],
  };
}
