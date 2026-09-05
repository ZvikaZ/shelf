import regularFontUrl from '../assets/fonts/FrankRuhlLibre-Regular.ttf?url';
import boldFontUrl from '../assets/fonts/FrankRuhlLibre-Bold.ttf?url';
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
 * The PDF fonts are fetched from our own origin on first use, rather than
 * bundled: they are ~100 kB that only a PDF export needs.
 */
let fontsPromise: Promise<PdfFonts> | null = null;

function pdfFonts(): Promise<PdfFonts> {
  fontsPromise ??= (async () => {
    const [regular, bold] = await Promise.all(
      [regularFontUrl, boldFontUrl].map(async (url) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error('טעינת הגופן נכשלה');
        return new Uint8Array(await res.arrayBuffer());
      }),
    );
    return { regular, bold };
  })();
  return fontsPromise;
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
    const fonts = await pdfFonts();
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
  saveBytes(
    await buildDocx(book, doc),
    downloadName(book, 'docx'),
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  );
}
