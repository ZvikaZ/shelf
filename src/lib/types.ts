import type { Provider } from './providers/registry';

export type { Provider };

/**
 * A book stands on its own; a commentary is written on one and is read woven
 * into it, so it carries the ref of the text it comments on.
 */
export type BookKind = 'book' | 'commentary';

export interface Book {
  /** Globally unique across providers, e.g. `dicta:alfeimenashe`. */
  id: string;
  provider: Provider;
  kind: BookKind;
  /** For a commentary, the work it comments on. */
  baseRef?: string;
  /**
   * Where the provider's loader finds the text: a Dicta archive URL, or a
   * Sefaria ref. Opaque to everything except that provider.
   */
  ref: string;
  /** A page a reader can go to for the source text, where one exists. */
  sourceUrl: string | null;
  title: string;
  titleEn: string | null;
  author: string | null;
  authorEn: string | null;
  category: string;
  categoryEn: string;
  subcategory: string;
  subcategoryEn: string;
  place: string | null;
  placeEn: string | null;
  year: number | null;
  source: string;
  reviewed: boolean;
  key: string;
}

export interface Facet {
  name: string;
  count: number;
}

export interface Facets {
  categories: Facet[];
  subcategories: Facet[];
  /** Which library each book came from. Absent from a single-library file. */
  sources?: Facet[];
  /** Books versus commentaries. Absent from a single-library file. */
  kinds?: Facet[];
  total: number;
  fetchedAt: string;
}

/**
 * Entries a catalogue file describes but does not carry, to be fetched only if
 * a reader asks for them. Sefaria's commentaries are 83% of its shelf and most
 * visitors never open one, so they are not worth a slow first paint.
 */
export interface Deferred {
  /** Catalogue file under public/ holding them. */
  file: string;
  kind: BookKind;
  count: number;
}

export interface Catalogue {
  facets: Facets;
  books: Book[];
  deferred?: Deferred[];
}

import type { Attribution } from './attribution';

export type BlockKind = 'heading' | 'para';

/** A run of words sharing one style. Bold is the only emphasis the OCR marks. */
export interface Span {
  text: string;
  bold: boolean;
}

export interface Block {
  kind: BlockKind;
  spans: Span[];
  /**
   * Citation slot: a Dicta scan folio, or an ordinal over Sefaria's sections.
   * Used for addressing — links, scroll restore, de-duplication — so it only
   * has to be stable and increasing, not meaningful.
   */
  page: number;
  /**
   * What gets printed for that slot: a folio number, or a Hebrew reference
   * like `ג׳:י״ב`. Defaults to the slot itself.
   */
  label?: string;
  /**
   * Set on a block that comments on the one above it rather than continuing
   * the text. Carries the source it came from, so the reader can indent it and
   * the exporters can set it apart.
   */
  layer?: string;
}

/** What a block's citation shows in the margin, contents and running head. */
export function blockLabel(block: Pick<Block, 'page' | 'label'>): string {
  return block.label ?? String(block.page);
}

/** How much structural markup the source actually carried. */
export type Fidelity = 'heading' | 'bold' | 'pages';

export interface BookDoc {
  blocks: Block[];
  pageCount: number;
  fidelity: Fidelity;
  /**
   * Who to credit and under what licence — set by the provider that loaded it.
   * A commentary woven together with the text it comments on draws on two
   * sources, often licensed differently, and both must be credited.
   */
  attribution: Attribution;
  /** Further sources this book was built from, credited alongside the first. */
  alsoFrom?: Attribution[];
  /**
   * The word that introduces a citation in running text — `דף` for a scanned
   * folio. A Sefaria reference names its own units, so it has none.
   */
  citation?: string;
}

export type ExportFormat = 'epub' | 'docx' | 'pdf';
