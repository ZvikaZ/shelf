import { combinedLicense, sefariaAttribution } from '../attribution';
import { buildSefariaDoc, HE_SECTION, type TextNode } from '../sefariaDoc';
import { weaveCommentary } from '../weave';
import type { BookDoc } from '../types';
import type { LoadBook } from './types';

const API = 'https://www.sefaria.org/api';

/**
 * The whole library is served with `Access-Control-Allow-Origin: *`.
 *
 * `label`, when given, names the specific section this call is for (its ref),
 * so a failure that survives every retry says which part of the book could
 * not be downloaded rather than just a bare status code.
 */
async function getJson<T>(url: string, label?: string): Promise<T> {
  // Cold refs return the odd 504, and a large complex book fires off a
  // request per section — with that many round trips, a transient hiccup on
  // one of them is expected. Three attempts with a growing pause clears most
  // of that; only a section that is still failing after that is a real error.
  const attempts = 3;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url);
    if (res.ok) return (await res.json()) as T;
    if (attempt >= attempts) {
      throw new Error(
        label
          ? `הורדת הקטע "${label}" נכשלה אחרי ${attempts} ניסיונות (שגיאה ${res.status})`
          : `הורדת הספר נכשלה (${res.status})`,
      );
    }
    await new Promise((r) => setTimeout(r, attempt * 800));
  }
}

interface SchemaNode {
  nodeType?: string;
  key?: string;
  /** Titles per language; the raw index carries no flat `title` field. */
  titles?: { lang: string; text: string; primary?: boolean }[];
  /** A handful of nodes point at a reusable title instead of carrying their own. */
  sharedTitle?: string;
  nodes?: SchemaNode[];
  depth?: number;
}

function titleIn(node: SchemaNode, lang: string): string | undefined {
  const titles = node.titles?.filter((t) => t.lang === lang) ?? [];
  return (titles.find((t) => t.primary) ?? titles[0])?.text;
}

/**
 * Resolves a `sharedTitle` (e.g. "Ushpizin") to its Hebrew text.
 *
 * Sefaria keeps a small set of section titles once, as reusable "terms",
 * rather than inline on every node that shares one — the node itself carries
 * only the term's name. One request per distinct term (cached, so a term
 * used by several sections is only fetched once) beats showing the English
 * key where every other heading in the book is Hebrew.
 */
const termCache = new Map<string, Promise<string | undefined>>();

async function termHebrew(name: string): Promise<string | undefined> {
  let promise = termCache.get(name);
  if (!promise) {
    promise = fetch(`${API}/terms/${encodeURIComponent(name)}`)
      .then((res) => (res.ok ? (res.json() as Promise<{ titles?: SchemaNode['titles'] }>) : null))
      .then((term) => titleIn({ titles: term?.titles }, 'he'))
      .catch(() => undefined);
    termCache.set(name, promise);
  }
  return promise;
}

interface TextResponse {
  versions?: {
    text: TextNode['text'];
    language?: string;
    versionTitle?: string;
    license?: string;
    versionSource?: string;
  }[];
  sectionNames?: string[];
  addressTypes?: string[];
  error?: string;
}

/**
 * Complex books reject a book-level ref and have to be fetched node by node.
 *
 * Their schema is a tree whose leaves are the addressable texts; the branch
 * titles join with commas to form the ref, exactly as they appear in a
 * citation (`Pesach Haggadah, Magid, Ha Lachma Anya`).
 */
async function leafRefs(
  node: SchemaNode,
  path: string[] = [],
): Promise<{ ref: string; heTitle?: string }[]> {
  const ownTitle = titleIn(node, 'en') ?? node.key ?? '';
  const here = [...path, ownTitle].filter(Boolean);
  if (!node.nodes?.length) {
    // Most schema nodes carry their own `titles`, but some (the Koren
    // Siddur's "Ushpizin", "Tefillin"...) instead point at a shared term via
    // `sharedTitle` and have no inline title of their own; `titleIn` sees
    // nothing in either language for those, so the term is resolved
    // separately. Falling all the way back to the English key/title (rather
    // than leaving heTitle blank) keeps the leaf "named" — see
    // buildSefariaDoc's `named` — even in the rare case a term fails to
    // resolve too: a blank heTitle makes the whole leaf look unnamed and
    // floods the reader's contents with a numbered "פסקה 1", "פסקה 2"...
    // heading per paragraph instead of the one heading the section actually
    // has.
    const heTitle =
      titleIn(node, 'he') ??
      (node.sharedTitle ? await termHebrew(node.sharedTitle) : undefined) ??
      (ownTitle || undefined);
    return [{ ref: here.join(', '), heTitle }];
  }
  const children = await Promise.all(node.nodes.map((child) => leafRefs(child, here)));
  return children.flat();
}

/**
 * Fetches one section (leaf) of a complex book, same retry policy as
 * `getJson` — but a 404 that survives every retry gets a different verdict
 * than any other status.
 *
 * A schema can declare a section (an "Ushpizin" heading, say) that Sefaria
 * never actually filled in for this particular edition; querying it 404s
 * every time, retries included, because there is nothing there to eventually
 * succeed at — not a transient failure, a permanent gap. Skipping only that
 * section lets the rest of a hundred-plus-section book still open. Any other
 * status (5xx, a network hiccup) is treated as it always was: retried, and
 * if it still fails, fatal for the whole book — that kind of failure might
 * well mean the rest of the download is unreliable too, so it is surfaced
 * rather than silently dropped.
 */
async function fetchSection(ref: string): Promise<TextResponse | null> {
  const attempts = 3;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${API}/v3/texts/${encodeURIComponent(ref)}?version=source`);
    if (res.ok) return (await res.json()) as TextResponse;
    if (attempt >= attempts) {
      if (res.status === 404) {
        console.warn(
          `Sefaria: "${ref}" still 404s after ${attempts} attempts — missing from this edition, skipping`,
        );
        return null;
      }
      throw new Error(
        `הורדת הקטע "${ref}" נכשלה אחרי ${attempts} ניסיונות (שגיאה ${res.status})`,
      );
    }
    await new Promise((r) => setTimeout(r, attempt * 800));
  }
}

/** A complex book's licence is carried by its sections, not by the book ref. */
async function firstVersion(ref: string) {
  const res = await fetchSection(ref);
  return res?.versions?.[0];
}

async function fetchNode(ref: string, heTitle?: string): Promise<TextNode | null> {
  const res = await fetchSection(ref);
  const version = res?.versions?.[0];
  if (!version) return null;
  return {
    heTitle,
    sectionNames: res.sectionNames ?? [],
    addressTypes: res.addressTypes ?? [],
    text: version.text,
  };
}

/**
 * `HE_SECTION` covers the common section names without a network round trip,
 * but the library uses many more ("Volume", "Gate", "Drush"...) that would
 * otherwise show up in a heading untranslated. Whatever a given book's nodes
 * actually use that isn't already covered gets resolved (and cached) the same
 * way a `sharedTitle` is, and merged over the static table.
 */
async function resolveSectionNames(nodes: TextNode[]): Promise<Record<string, string>> {
  const unknown = new Set(nodes.flatMap((n) => n.sectionNames).filter((n) => !(n in HE_SECTION)));
  if (unknown.size === 0) return HE_SECTION;
  const resolved = await Promise.all([...unknown].map(async (n) => [n, await termHebrew(n)] as const));
  const merged = { ...HE_SECTION };
  for (const [name, he] of resolved) if (he) merged[name] = he;
  return merged;
}

/**
 * Sefaria serves a "simple" book whole in one request — a few hundred KB, well
 * under a second. Only a complex book costs one request per section, so the
 * cheap path is tried first and the schema is only fetched if it fails.
 */
export const loadBook: LoadBook = async (book, onProgress): Promise<BookDoc> => {
  const doc = await loadText(book.ref, onProgress);

  // A commentary is read woven into the work it comments on, the way a printed
  // commentary sets the verse above the comment.
  if (book.kind === 'commentary' && book.baseRef) {
    const base = await loadText(book.baseRef);
    return {
      ...doc,
      blocks: weaveCommentary(base, doc),
      // The commentary leads — it is its book — but both sources are credited,
      // and the stricter of the two licences governs the whole.
      alsoFrom: [base.attribution],
      attribution: {
        ...doc.attribution,
        license: combinedLicense([doc.attribution, base.attribution]),
      },
    };
  }

  return doc;
};

async function loadText(ref: string, onProgress?: Parameters<LoadBook>[1]): Promise<BookDoc> {
  onProgress?.('download', 0.1);

  const whole = await fetch(
    `${API}/v3/texts/${encodeURIComponent(ref)}?version=source`,
  ).then((r) => r.json() as Promise<TextResponse>);

  let nodes: TextNode[];
  // The licence belongs to the edition, so it is read from whichever version
  // actually came back rather than assumed from the library.
  let version: NonNullable<TextResponse['versions']>[number] | undefined = whole.versions?.[0];

  if (!whole.error && whole.versions?.[0]) {
    onProgress?.('download', 1);
    nodes = [
      {
        sectionNames: whole.sectionNames ?? [],
        addressTypes: whole.addressTypes ?? [],
        text: whole.versions[0].text,
      },
    ];
  } else {
    // Complex book: walk the schema and pull each leaf.
    const index = await getJson<{ schema: SchemaNode }>(
      `${API}/v2/raw/index/${encodeURIComponent(ref)}`,
    );
    const refs = await leafRefs(index.schema);
    if (refs.length === 0) throw new Error('לא נמצא טקסט לספר הזה');
    version = await firstVersion(refs[0].ref);

    // The Haggadah is 38 sections; fetched one at a time that is eight seconds
    // of latency. Six at once keeps it near one, and the results are placed by
    // index so the book stays in its schema order.
    const fetched: (TextNode | null)[] = new Array(refs.length).fill(null);
    let next = 0;
    let done = 0;
    await Promise.all(
      Array.from({ length: Math.min(6, refs.length) }, async () => {
        for (;;) {
          const i = next++;
          if (i >= refs.length) return;
          fetched[i] = await fetchNode(refs[i].ref, refs[i].heTitle);
          onProgress?.('download', ++done / refs.length);
        }
      }),
    );
    nodes = fetched.filter((n): n is TextNode => n !== null);
  }

  onProgress?.('parse', 1);
  const sectionNames = await resolveSectionNames(nodes);
  const doc = buildSefariaDoc(nodes, sefariaAttribution(version ?? {}), sectionNames);
  if (doc.blocks.length === 0) throw new Error('לא נמצא טקסט לספר הזה');

  onProgress?.('build', 1);
  return doc;
}
