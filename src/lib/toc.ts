import { blockText } from './parseOcr';
import { blockLabel, type BookDoc } from './types';

/** Single source of truth for anchor ids, shared by the TOC and the renderers. */
export function headingId(blockIndex: number): string {
  return `h${blockIndex}`;
}

export interface TocEntry {
  text: string;
  /** Heading depth; see Block.level. Unset where a book has no hierarchy. */
  level?: number;
  /** Citation slot the section opens on. */
  page: number;
  /** What that slot prints — a folio number, or a Hebrew reference. */
  label: string;
  /** Anchor id, unique across the book. */
  id: string;
}

/**
 * A visible table of contents, derived from the detected headings.
 *
 * The reader's own navigation covers EPUB, but DOCX and print have no such
 * affordance, so the contents page is generated into the document itself.
 * Folio numbers come from the scan, which makes them citable against the
 * printed edition rather than against our pagination.
 */
export function tocEntries(doc: BookDoc): TocEntry[] {
  const entries: TocEntry[] = [];
  doc.blocks.forEach((b, i) => {
    if (b.kind !== 'heading') return;
    const text = blockText(b).trim();
    if (text)
      entries.push({ text, page: b.page, label: blockLabel(b), id: headingId(i), level: b.level });
  });
  return entries;
}

/** Below this a contents page is noise rather than navigation. */
const MIN_ENTRIES = 3;

export function shouldIncludeToc(entries: TocEntry[]): boolean {
  return entries.length >= MIN_ENTRIES;
}

export interface VisibleEntry extends TocEntry {
  /** Nesting depth below the top level shown, for indentation. */
  depth: number;
  /** Whether its sections are shown; unset where it has none. */
  open?: boolean;
}

/**
 * The contents as the reader's drawer shows it: the top level always, and
 * below it only the branch being read. A responsa collection numbers each
 * part from א again, so the full list repeats every number five times and
 * runs to a thousand lines; folded, it is the five parts plus where you are.
 * A book with a single level of headings is shown whole, as before.
 */
export function visibleEntries(entries: TocEntry[], activeId: string | null): VisibleEntry[] {
  const level = (e: TocEntry) => e.level ?? 0;
  // Each entry's parent is the nearest earlier entry at a shallower level.
  const parents: number[] = [];
  const stack: number[] = [];
  entries.forEach((e, i) => {
    while (stack.length && level(entries[stack[stack.length - 1]]) >= level(e)) stack.pop();
    parents.push(stack.length ? stack[stack.length - 1] : -1);
    stack.push(i);
  });
  const hasChildren = new Set(parents.filter((p) => p >= 0));

  const onPath = new Set<number>();
  for (let i = entries.findIndex((e) => e.id === activeId); i >= 0; i = parents[i]) onPath.add(i);

  const depth = (i: number): number => (parents[i] < 0 ? 0 : depth(parents[i]) + 1);
  const out: VisibleEntry[] = [];
  entries.forEach((e, i) => {
    if (parents[i] >= 0 && !onPath.has(parents[i])) return;
    out.push({
      ...e,
      depth: depth(i),
      open: hasChildren.has(i) ? onPath.has(i) : undefined,
    });
  });
  return out;
}

/**
 * The part of the book a block is in — "יורה דעה" — for the reader's bar, where
 * a bare `קכג:ה` could be in any of a responsa collection's parts. Unset for a
 * book of one part, which the title already names.
 */
export function currentPart(doc: BookDoc, blockIndex: number): string | undefined {
  const parts = doc.blocks.filter((b) => b.kind === 'heading' && b.level === 2);
  if (parts.length < 2) return undefined;
  for (let i = Math.min(blockIndex, doc.blocks.length - 1); i >= 0; i--) {
    const b = doc.blocks[i];
    if (b.kind === 'heading' && b.level === 2) return blockText(b).trim();
  }
  return undefined;
}
