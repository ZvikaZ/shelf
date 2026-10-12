import { describe, expect, it } from 'vitest';
import { makeDoc } from '../test/fixtures';
import { currentPart, visibleEntries, type TocEntry } from './toc';
import type { Block } from './types';

const entry = (id: string, text: string, level?: number): TocEntry => ({
  id,
  text,
  level,
  page: 1,
  label: '',
});

// Responsa Chatam Sofer, in miniature: five parts, each numbering from א.
const chatamSofer = [
  entry('oc', 'אורח חיים', 2),
  entry('oc1', 'תשובה א', 3),
  entry('oc2', 'תשובה ב', 3),
  entry('eh', 'אבן העזר', 2),
  entry('eh-1', 'חלק א', 3),
  entry('eh-1-1', 'תשובה א', 4),
  entry('eh-2', 'חלק ב', 3),
  entry('eh-2-1', 'תשובה א', 4),
  entry('cm', 'חושן משפט', 2),
  entry('cm1', 'תשובה א', 3),
];

const shown = (active: string | null) =>
  visibleEntries(chatamSofer, active).map((e) => [e.id, e.depth, e.open]);

describe('visibleEntries', () => {
  it('shows only the parts before the reader is inside one', () => {
    expect(shown(null)).toEqual([
      ['oc', 0, false],
      ['eh', 0, false],
      ['cm', 0, false],
    ]);
  });

  it('opens the branch the reader is in, and only that branch', () => {
    expect(shown('eh-2-1')).toEqual([
      ['oc', 0, false],
      ['eh', 0, true],
      ['eh-1', 1, false],
      ['eh-2', 1, true],
      ['eh-2-1', 2, undefined],
      ['cm', 0, false],
    ]);
  });

  it('lets the reader close the branch they are in, or open another', () => {
    const chosen = new Map([
      ['eh', false],
      ['cm', true],
    ]);
    expect(visibleEntries(chatamSofer, 'eh-2-1', chosen).map((e) => [e.id, e.open])).toEqual([
      ['oc', false],
      ['eh', false],
      ['cm', true],
      ['cm1', undefined],
    ]);
  });

  it('keeps a part closed by hand closed once the reader moves on', () => {
    const chosen = new Map([['oc', false]]);
    expect(visibleEntries(chatamSofer, 'cm1', chosen).map((e) => [e.id, e.open])).toEqual([
      ['oc', false],
      ['eh', false],
      ['cm', true],
      ['cm1', undefined],
    ]);
  });

  it('leaves a book with one level as the flat list it was', () => {
    const flat = [entry('a', 'סימן א'), entry('b', 'סימן ב'), entry('c', 'סימן ג')];
    expect(visibleEntries(flat, 'b').map((e) => [e.id, e.depth, e.open])).toEqual([
      ['a', 0, undefined],
      ['b', 0, undefined],
      ['c', 0, undefined],
    ]);
  });
});

describe('currentPart', () => {
  const heading = (text: string, level: number): Block => ({
    kind: 'heading',
    level,
    page: 1,
    spans: [{ text, bold: false }],
  });
  const para: Block = { kind: 'para', page: 1, spans: [{ text: 'טקסט', bold: false }] };

  it('names the part the reader is in', () => {
    const doc = makeDoc({
      blocks: [heading('אורח חיים', 2), heading('תשובה א', 3), para, heading('יורה דעה', 2), heading('תשובה א', 3), para],
    });
    expect(currentPart(doc, 2)).toBe('אורח חיים');
    expect(currentPart(doc, 5)).toBe('יורה דעה');
  });

  it('says nothing where a book has only one part', () => {
    const doc = makeDoc({ blocks: [heading('קדש', 2), para] });
    expect(currentPart(doc, 1)).toBeUndefined();
  });
});
