import { describe, expect, it } from 'vitest';
import { hasCantillation, textHasCantillation } from './cantillation';
import { makeDoc } from '../test/fixtures';

const doc = (...texts: string[]) =>
  makeDoc({ blocks: texts.map((t) => ({ kind: 'para' as const, page: 1, spans: [{ text: t, bold: false }] })) });

describe('deciding a book needs a cantillation face', () => {
  it('sees te\u2019amim in a pointed verse', () => {
    expect(hasCantillation(doc('בְּרֵאשִׁ֖ית בָּרָ֣א אֱלֹהִ֑ים'))).toBe(true);
  });

  it('does not mistake plain nikud for te\u2019amim', () => {
    // Pointing alone is set perfectly well by the face already in use.
    expect(hasCantillation(doc('בְּרֵאשִׁית בָּרָא אֱלֹהִים'))).toBe(false);
  });

  it('leaves an unpointed Dicta book alone', () => {
    expect(hasCantillation(doc('ענין הטבעים', 'הנה כל האש'))).toBe(false);
  });

  it('catches a commentary that quotes an accented verse partway through', () => {
    expect(hasCantillation(doc('דברי המחבר', 'ועל זה נאמר שִׁ֥יר הַשִּׁירִ֖ים'))).toBe(true);
  });

  it('judges a single string too', () => {
    expect(textHasCantillation('אֵ֥ת')).toBe(true);
    expect(textHasCantillation('את')).toBe(false);
  });
});
