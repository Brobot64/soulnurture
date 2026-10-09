import { LanguageDetectorService } from './language-detector.service.js';

describe('LanguageDetectorService', () => {
  let detector: LanguageDetectorService;

  beforeEach(() => {
    detector = new LanguageDetectorService();
  });

  it('detects Yoruba from its diacritics', () => {
    expect(detector.detect('Mo ti rẹ̀ rẹ̀ lónìí')).toEqual({
      lang: 'yo',
      confidence: 'high',
      method: 'diacritics',
    });
  });

  it('detects Hausa from its hooked letters', () => {
    expect(detector.detect('Ina jin ɓacin rai sosai')).toEqual({
      lang: 'ha',
      confidence: 'high',
      method: 'diacritics',
    });
  });

  it('detects Igbo from its diacritics', () => {
    expect(detector.detect('Obi m na-akụ nke ukwuu')).toEqual({
      lang: 'ig',
      confidence: 'high',
      method: 'diacritics',
    });
  });

  it("falls through on a shared-letter tie ('ọ' is both Yoruba and Igbo)", () => {
    const detection = detector.detect('ọ');
    expect(detection.lang).toBeNull();
    expect(detection.method).toBe('fallback');
  });

  it('detects Pidgin with two markers at medium confidence', () => {
    expect(detector.detect('Abeg dey')).toEqual({
      lang: 'pcm',
      confidence: 'medium',
      method: 'pidgin-markers',
    });
  });

  it('detects Pidgin with three markers at high confidence', () => {
    expect(detector.detect('Abeg wetin dey happen')).toEqual({
      lang: 'pcm',
      confidence: 'high',
      method: 'pidgin-markers',
    });
  });

  it('counts phrase markers before franc would call Pidgin English', () => {
    expect(detector.detect('No vex, e don finish')).toEqual({
      lang: 'pcm',
      confidence: 'medium',
      method: 'pidgin-markers',
    });
  });

  it('treats a single Pidgin marker as noise', () => {
    const detection = detector.detect('dey');
    expect(detection.lang).not.toBe('pcm');
    expect(detection.method).not.toBe('pidgin-markers');
  });

  it('detects English via franc at medium confidence', () => {
    const detection = detector.detect(
      'We walked to the market together and bought some oranges for our friends.',
    );
    expect(detection).toEqual({
      lang: 'en',
      confidence: 'medium',
      method: 'franc',
    });
  });

  it('falls back to a null language for short ambiguous text', () => {
    expect(detector.detect('ok')).toEqual({
      lang: null,
      confidence: 'low',
      method: 'fallback',
    });
  });

  it('detects pure Yoruba via the lexicon (franc says ibo for this text)', () => {
    expect(detector.detect('mi o ti jeun lati aaro mo fe lo ile mi')).toEqual({
      lang: 'yo',
      confidence: 'high',
      method: 'lexicon',
    });
  });

  it('detects Yoruba inside a mixed English message', () => {
    const detection = detector.detect(
      "I'm feeling sad. I think it's because of school. mi o ti jeun lati aaro mo fe lo ile mi",
    );
    expect(detection.lang).toBe('yo');
    expect(detection.method).toBe('lexicon');
  });

  it('detects Hausa via the lexicon', () => {
    expect(detector.detect('yanzu ina kwana a gida')).toEqual({
      lang: 'ha',
      confidence: 'medium',
      method: 'lexicon',
    });
  });

  it('detects Igbo via the lexicon', () => {
    expect(detector.detect('nne nna ndewo gini')).toEqual({
      lang: 'ig',
      confidence: 'medium',
      method: 'lexicon',
    });
  });

  it('never lets franc assert a Nigerian language', () => {
    // Pre-lexicon, "I am happy" was misread as hausa by franc.
    expect(detector.detect('I am happy')).toEqual({
      lang: null,
      confidence: 'low',
      method: 'fallback',
    });
  });

  it('does not fire on lone 2-letter Yoruba words', () => {
    const detection = detector.detect('mo mi fe');
    expect(detection.lang).not.toBe('yo');
    expect(detection.method).toBe('fallback');
  });
});
