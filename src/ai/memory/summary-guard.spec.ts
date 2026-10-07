import { filterSummaryText } from './summary-guard.js';

describe('filterSummaryText', () => {
  it('keeps clean sentences untouched', () => {
    const text =
      'We talked about exam stress. The student felt lighter afterwards.';
    const result = filterSummaryText(text);

    expect(result.text).toBe(text);
    expect(result.notes).toEqual([]);
  });

  it('drops diagnosis and clinical-label sentences with a note', () => {
    const result = filterSummaryText(
      'The student shared about exams. The student has clinical depression.',
    );

    expect(result.text).toBe('The student shared about exams.');
    expect(result.notes.join(' ')).toContain('diagnosis');
  });

  it('drops medication talk', () => {
    const result = filterSummaryText(
      'Sleep has been hard lately. The counsellor may prescribe medication.',
    );

    expect(result.text).toBe('Sleep has been hard lately.');
    expect(result.notes.join(' ')).toContain('medication');
  });

  it('drops secrecy requests', () => {
    const result = filterSummaryText(
      'They asked to keep this a secret. They felt safer after talking.',
    );

    expect(result.text).toBe('They felt safer after talking.');
    expect(result.notes.join(' ')).toContain('secrecy');
  });

  it('drops sentences repeating safeguarding keywords verbatim', () => {
    const result = filterSummaryText(
      'They wanted to end it all. They agreed to speak to a counsellor.',
    );

    expect(result.text).toBe('They agreed to speak to a counsellor.');
    expect(result.notes.join(' ')).toContain('crisis wording');
  });

  it('returns null with notes when every sentence is dropped', () => {
    const result = filterSummaryText('The student has clinical depression.');

    expect(result.text).toBeNull();
    expect(result.notes.length).toBeGreaterThan(0);
  });
});
