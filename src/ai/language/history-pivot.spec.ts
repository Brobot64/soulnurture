import { pivotTurnText } from './history-pivot.js';

describe('pivotTurnText (history_en)', () => {
  it('pivots a USER turn to its VERNACULAR understanding', () => {
    expect(
      pivotTurnText({
        role: 'USER',
        content: 'Mo ti rẹ̀ rẹ̀ lónìí',
        aiPayload: { understanding: { englishTranslation: 'I am tired today.' } },
      }),
    ).toBe('I am tired today.');
  });

  it('pivots an ASSISTANT turn to the render English source', () => {
    expect(
      pivotTurnText({
        role: 'ASSISTANT',
        content: 'Mo wà níbí pẹ̀lú rẹ.',
        aiPayload: { render: { englishSource: 'I am here with you.' } },
      }),
    ).toBe('I am here with you.');
  });

  it('falls back to raw content when no pivot exists', () => {
    expect(
      pivotTurnText({ role: 'USER', content: 'hello', aiPayload: null }),
    ).toBe('hello');
    expect(
      pivotTurnText({
        role: 'ASSISTANT',
        content: 'Morning! How are you?',
        aiPayload: { applicationNotes: [] },
      }),
    ).toBe('Morning! How are you?');
  });

  it('treats an empty or malformed pivot as absent', () => {
    expect(
      pivotTurnText({
        role: 'USER',
        content: 'Mo ti rẹ̀ rẹ̀',
        aiPayload: { understanding: { englishTranslation: '' } },
      }),
    ).toBe('Mo ti rẹ̀ rẹ̀');
    expect(
      pivotTurnText({
        role: 'ASSISTANT',
        content: 'Ó dàbọ̀',
        aiPayload: 'not-an-object',
      }),
    ).toBe('Ó dàbọ̀');
  });
});
