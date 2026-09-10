import regularFontUrl from '../assets/fonts/FrankRuhlLibre-Regular.ttf?url';
import boldFontUrl from '../assets/fonts/FrankRuhlLibre-Bold.ttf?url';
import taamimRegularUrl from '../assets/fonts/TaameyD.ttf?url';
import { hasCantillation } from './cantillation';
import { buildDocx } from './docx';
import { downloadName } from './filename';
import { buildEpub } from './epub';
import { getDoc } from './bookCache';
import type { Progress } from './providers/types';
import { buildPdf, type PdfFonts } from './pdf';
import type { Book, ExportFormat } from './types';

export function saveBytes(bytes: Uint8Array, fileName: string, mime: string): void {
  const blob = new Blob([bytes as unknown as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * The two faces a book can be set in.
 *
 * Frank Ruhl Libre has no cantillation glyphs at all, so an accented text set
 * in it loses every ta'am silently. Taamey D carries all thirty-one — it is
 * Culmus's Frank Ruhl adaptation with Denckla's rewritten positioning, which
 * matters for the common case of a letter taking two marks below: hiriq and
 * meteg together collide in a font that only positions marks against the base
 * letter, and הַשְׁמִיעִֽנִי is not a rare word.
 *
 * It ships in one weight, so bold reuses it: in an accented text the headings
 * are already distinguished by size and centring. It is used only where the
 * text needs it — no reason to change how the rest of the shelf looks, or to
 * make every reader fetch a font their book does not use.
 */
const FACES = {
  plain: { regular: regularFontUrl, bold: boldFontUrl, cantillation: false },
  taamim: { regular: taamimRegularUrl, bold: taamimRegularUrl, cantillation: true },
} as const;

type Face = keyof typeof FACES;

/**
 * Fetched from our own origin on first use, rather than bundled: each face is
 * ~100 kB that only a PDF export needs.
 */
const fontsByFace = new Map<Face, Promise<PdfFonts>>();

function pdfFonts(face: Face): Promise<PdfFonts> {
  let pending = fontsByFace.get(face);
  if (!pending) {
    const spec = FACES[face];
    pending = (async () => {
      // Fetched per distinct URL, not per slot: a one-weight face names the
      // same file twice, and downloading it twice would also embed it twice.
      const bytes = new Map<string, Promise<Uint8Array>>();
      const load = (url: string) => {
        let got = bytes.get(url);
        if (!got) {
          got = (async () => {
            const res = await fetch(url);
            if (!res.ok) throw new Error('טעינת הגופן נכשלה');
            return new Uint8Array(await res.arrayBuffer());
          })();
          bytes.set(url, got);
        }
        return got;
      };
      const [regular, bold] = await Promise.all([load(spec.regular), load(spec.bold)]);
      return { regular, bold, hasCantillation: spec.cantillation };
    })();
    fontsByFace.set(face, pending);
  }
  return pending;
}

export async function exportBook(
  book: Book,
  format: ExportFormat,
  onProgress?: Progress,
): Promise<void> {
  const doc = await getDoc(book, onProgress);

  // Enforced here, not only where the buttons are drawn. The reader disables
  // the menu and the static export skips these, but the rule belongs with the
  // work: an edition naming a rights holder is not ours to hand out, and a
  // future caller should not have to know that.
  if (!doc.attribution.license.exportable) {
    throw new Error('המהדורה הזו מוגנת בזכויות יוצרים ואינה ניתנת להורדה.');
  }

  if (format === 'pdf') {
    const fonts = await pdfFonts(hasCantillation(doc) ? 'taamim' : 'plain');
    const bytes = await buildPdf(book, doc, fonts, (ratio) => onProgress?.('build', ratio));
    saveBytes(bytes, downloadName(book, 'pdf'), 'application/pdf');
    return;
  }
  if (format === 'epub') {
    onProgress?.('build', 0.5);
    saveBytes(await buildEpub(book, doc), downloadName(book, 'epub'), 'application/epub+zip');
    onProgress?.('build', 1);
    return;
  }
  onProgress?.('build', 0.5);
  // The same font the PDF would use, embedded in the file so an accented text
  // sets its te'amim on a machine that does not have it installed.
  const taamim = hasCantillation(doc) ? (await pdfFonts('taamim')).regular : undefined;
  saveBytes(
    await buildDocx(book, doc, taamim),
    downloadName(book, 'docx'),
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  );
}
