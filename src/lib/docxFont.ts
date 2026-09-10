import JSZip from 'jszip';

/**
 * Embed a font in a .docx so it travels with the file.
 *
 * Word will not fetch a font, and it will not warn you: a document naming a
 * face nobody has installed silently falls back to one that has no te'amim,
 * which is how a vocalised text loses its accents on someone else's machine.
 * OOXML's answer is to carry the font inside the package, which Word then uses
 * for display without installing it.
 *
 * The `docx` library has no support for this, so the package is reopened and
 * the five parts involved are patched by hand.
 */

/** Fixed rather than random, so building the same book twice gives the same file. */
const FONT_KEY = '{B1A2C3D4-5E6F-4A7B-8C9D-0E1F2A3B4C5D}';
const REL_ID = 'rIdEmbeddedFont';
const PART = 'fonts/font1.odttf';

const FONT_REL_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/font';
const ODTTF_TYPE = 'application/vnd.openxmlformats-officedocument.obfuscatedFont';

/**
 * Word stores embedded fonts lightly scrambled, as `.odttf`.
 *
 * The first 32 bytes are XORed with the 16 bytes of the font key, read in
 * reverse. It is obfuscation rather than encryption — its purpose is to stop a
 * font being lifted out of a document by renaming the file.
 */
export function obfuscate(font: Uint8Array, key = FONT_KEY): Uint8Array {
  const hex = key.replace(/[{}-]/g, '');
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.slice(30 - i * 2, 32 - i * 2), 16);
  const out = font.slice();
  for (let i = 0; i < 32 && i < out.length; i++) out[i] ^= bytes[i % 16];
  return out;
}

/** Point every run at the embedded family instead of the one asked for. */
function rename(xml: string, from: string, to: string): string {
  return xml.replace(
    new RegExp(`(w:(?:ascii|hAnsi|cs|eastAsia)=")${from}(")`, 'g'),
    `$1${to}$2`,
  );
}

export async function embedDocxFont(
  docx: Uint8Array,
  ttf: Uint8Array,
  family: string,
  replacing: string,
): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(docx);

  for (const name of Object.keys(zip.files)) {
    if (/^word\/(document|styles|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(name)) {
      zip.file(name, rename(await zip.file(name)!.async('string'), replacing, family));
    }
  }

  zip.file(`word/${PART}`, obfuscate(ttf));

  // Word ignores an embedded font unless the document asks for embedding. The
  // element's position matters: CT_Settings is a sequence, and this belongs
  // after displayBackgroundShape.
  const settings = await zip.file('word/settings.xml')!.async('string');
  zip.file(
    'word/settings.xml',
    settings.includes('<w:displayBackgroundShape/>')
      ? settings.replace(
          '<w:displayBackgroundShape/>',
          '<w:displayBackgroundShape/><w:embedTrueTypeFonts/><w:saveSubsetFonts w:val="false"/>',
        )
      : settings.replace(
          /(<w:settings[^>]*>)/,
          '$1<w:embedTrueTypeFonts/><w:saveSubsetFonts w:val="false"/>',
        ),
  );

  const entry =
    `<w:font w:name="${family}">` +
    `<w:embedRegular r:id="${REL_ID}" w:fontKey="${FONT_KEY}"/>` +
    `</w:font>`;
  const table = await zip.file('word/fontTable.xml')!.async('string');
  zip.file(
    'word/fontTable.xml',
    // The library emits an empty, self-closing <w:fonts/>.
    table.includes('</w:fonts>')
      ? table.replace('</w:fonts>', `${entry}</w:fonts>`)
      : table.replace(/<w:fonts([^>]*)\/>/, `<w:fonts$1>${entry}</w:fonts>`),
  );

  const rel = `<Relationship Id="${REL_ID}" Type="${FONT_REL_TYPE}" Target="${PART}"/>`;
  const rels = await zip.file('word/_rels/fontTable.xml.rels')!.async('string');
  zip.file(
    'word/_rels/fontTable.xml.rels',
    rels.includes('</Relationships>')
      ? rels.replace('</Relationships>', `${rel}</Relationships>`)
      : rels.replace(/<Relationships([^>]*)\/>/, `<Relationships$1>${rel}</Relationships>`),
  );

  const types = await zip.file('[Content_Types].xml')!.async('string');
  if (!types.includes('Extension="odttf"')) {
    zip.file(
      '[Content_Types].xml',
      types.replace(/(<Types[^>]*>)/, `$1<Default Extension="odttf" ContentType="${ODTTF_TYPE}"/>`),
    );
  }

  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
