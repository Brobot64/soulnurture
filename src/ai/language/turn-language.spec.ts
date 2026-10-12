import { resolveTurnLanguage } from './turn-language.js';

describe('resolveTurnLanguage', () => {
  it('a confident detection wins over the conversation language and the preference', () => {
    expect(
      resolveTurnLanguage({
        detected: 'en',
        conversationLanguage: 'ha',
        preferredLanguage: 'ha',
      }),
    ).toBe('en');
  });

  it('a silent message inherits the conversation language, not the preference', () => {
    // "ok" after a Hausa exchange: the student's preference is English, but
    // the conversation has been Hausa — the reply must stay Hausa.
    expect(
      resolveTurnLanguage({
        detected: null,
        conversationLanguage: 'ha',
        preferredLanguage: 'en',
      }),
    ).toBe('ha');
  });

  it('a silent first turn falls back to the preference', () => {
    expect(
      resolveTurnLanguage({
        detected: null,
        conversationLanguage: null,
        preferredLanguage: 'yo',
      }),
    ).toBe('yo');
  });

  it('a silent message with no conversation language and no preference is English', () => {
    expect(
      resolveTurnLanguage({
        detected: null,
        conversationLanguage: null,
        preferredLanguage: null,
      }),
    ).toBe('en');
  });

  it('ignores stored values that are not supported codes', () => {
    expect(
      resolveTurnLanguage({
        detected: null,
        conversationLanguage: 'fr',
        preferredLanguage: 'ig',
      }),
    ).toBe('ig');
  });
});
