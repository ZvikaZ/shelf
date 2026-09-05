/**
 * Who a text belongs to, and under what terms.
 *
 * Dicta releases its whole library under one licence, so its attribution is a
 * constant. Sefaria's licence belongs to the *edition* — the same work can be
 * public domain in one version and under copyright in another — so it has to be
 * read from the version the loader actually fetched, and carried on the
 * BookDoc rather than baked into the exporters.
 */
export interface Attribution {
  /** The library, as it should be credited. */
  library: string;
  libraryUrl: string;
  /** One sentence of credit, shown on the title page of every export. */
  about: string;
  /** How this text was produced — the OCR caveat, or which edition it is. */
  provenance: string;
  license: License;
  /** A further data-source credit, where the library asks for one. */
  dataLabel?: string;
  dataUrl?: string;
}

export interface License {
  /** Shown to the reader, in Hebrew where there is a Hebrew name for it. */
  name: string;
  url?: string;
  /**
   * Whether we may hand the reader a file of it. False only for editions
   * marked with an explicit copyright holder.
   */
  exportable: boolean;
}

const CC = 'https://creativecommons.org/licenses';

const KNOWN: Record<string, License> = {
  'public domain': { name: 'נחלת הכלל', exportable: true },
  pd: { name: 'נחלת הכלל', exportable: true },
  cc0: { name: 'CC0 — ללא זכויות שמורות', url: `${CC.replace('/licenses', '')}/publicdomain/zero/1.0/`, exportable: true },
  'cc-by': { name: 'Creative Commons BY 4.0', url: `${CC}/by/4.0/`, exportable: true },
  'cc-by-sa': { name: 'Creative Commons BY-SA 4.0', url: `${CC}/by-sa/4.0/`, exportable: true },
  'cc-by-nc': { name: 'Creative Commons BY-NC 4.0', url: `${CC}/by-nc/4.0/`, exportable: true },
  'cc-by-nc-sa': { name: 'Creative Commons BY-NC-SA 4.0', url: `${CC}/by-nc-sa/4.0/`, exportable: true },
};

/**
 * Sefaria's licence strings are not normalised — `PD` and `Public Domain` both
 * occur, as does an empty one — so this stays forgiving. An unrecognised value
 * beginning `Copyright:` names a rights holder and blocks export; anything else
 * unrecognised is shown as undocumented, which is Sefaria's own posture.
 */
export function licenseFor(raw: string | null | undefined): License {
  const key = (raw ?? '').trim();
  if (!key || /^unknown$/i.test(key)) return { name: 'לא מתועד', exportable: true };
  const known = KNOWN[key.toLowerCase()];
  if (known) return known;
  if (/^copyright/i.test(key)) return { name: key, exportable: false };
  return { name: key, exportable: true };
}

/**
 * The terms a book made of several sources must be offered under: every source
 * credited, and the strictest rule among them winning. One un-exportable part
 * makes the whole un-exportable.
 */
export function combinedLicense(parts: Attribution[]): License {
  const blocked = parts.find((p) => !p.license.exportable);
  if (blocked) return blocked.license;
  const named = parts.map((p) => p.license.name);
  const distinct = [...new Set(named)];
  if (distinct.length === 1) return parts[0].license;
  return { name: distinct.join(' · '), exportable: true };
}

export const DICTA_SITE = 'https://library.dicta.org.il';
export const DICTA_REPO =
  'https://github.com/Dicta-Israel-Center-for-Text-Analysis/Dicta-Library-Download';
export const SEFARIA_SITE = 'https://www.sefaria.org';

export const DICTA_ATTRIBUTION: Attribution = {
  library: 'הספרייה של דיקטה',
  libraryUrl: DICTA_SITE,
  about:
    'מיזם של דיקטה, המרכז הישראלי לניתוח טקסטים, המנגיש טקסטים תורניים לציבור ' +
    'באמצעות זיהוי תווים אוטומטי. תודה על העבודה ועל השחרור לשימוש חופשי.',
  // Dicta's own caveat, from their README: the processes are automatic, so the
  // text may carry errors. Kept because they say it, not because we assume it.
  provenance: 'הטקסט הופק בסריקה ובזיהוי אוטומטי (OCR) וייתכנו בו שיבושים.',
  license: licenseFor('CC-BY-SA'),
  dataLabel: 'Dicta-Library-Download',
  dataUrl: DICTA_REPO,
};

export function sefariaAttribution(version: {
  versionTitle?: string;
  license?: string;
  versionSource?: string;
}): Attribution {
  return {
    library: 'ספריא',
    libraryUrl: SEFARIA_SITE,
    about:
      'מיזם ספריא (Sefaria) מנגיש ספריית טקסטים יהודיים דיגיטלית לציבור ללא עלות. ' +
      'תודה על המיזם ועל שחרור הטקסטים לשימוש חופשי.',
    provenance: version.versionTitle
      ? `מהדורה: ${version.versionTitle}`
      : 'מהדורה דיגיטלית מספריית ספריא.',
    license: licenseFor(version.license),
    dataLabel: version.versionSource ? 'מקור המהדורה' : undefined,
    dataUrl: version.versionSource || undefined,
  };
}
