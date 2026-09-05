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
