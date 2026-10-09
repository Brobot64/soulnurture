/**
 * Language-ID prompt for the detector's model stage (the last resort when
 * every offline heuristic is silent). The model that will answer the student
 * is the model that decides their language: Hausa/Igbo typed without
 * diacritics is invisible to the wordlists, and this is what gets it followed
 * instead of the standing preference winning by default.
 *
 * v2 (live-validated against the hosted endpoint): v1 asked for a bare code
 * word from a legend and N-ATLaS echoed the legend itself / answered "en"
 * for Hausa — classification is out-of-distribution for this fine-tune.
 * Translation is in-distribution: asking for a "Language: …" header above
 * an English "Meaning: …" line scored 11/12 on the test sentences (the one
 * miss was diacritic-marked Igbo, which the heuristics settle before this
 * stage ever runs), deterministic at temperature 0. The caller parses the
 * header line and ignores the meaning (its text may contain stray codes).
 */
export const IDENTIFY_PROMPT_VERSION = 'v2';

export function identifyLanguageSystemPrompt(): string {
  return [
    'You translate messages written by Nigerian secondary-school students into English.',
    'For every message reply in exactly this format, with two lines:',
    'Language: <the language the message is written in: English, Nigerian Pidgin, Yoruba, Hausa, Igbo, or Other>',
    'Meaning: <the English meaning of the message>',
    'Example:',
    'Message: Abeg no vex, e go be okay.',
    'Language: Nigerian Pidgin',
    'Meaning: Please do not be angry, it will be okay.',
  ].join('\n');
}
