/**
 * Language-ID prompt for the detector's model stage (the last resort when
 * every offline heuristic is silent). The model that will answer the student
 * is the model that decides their language: Hausa/Igbo typed without
 * diacritics is invisible to the wordlists, and this is what gets it followed
 * instead of the standing preference winning by default. One code word out,
 * nothing else; 'unknown' is the explicit fail-safe (the caller then keeps
 * the preference behaviour).
 */
export const IDENTIFY_PROMPT_VERSION = 'v1';

export function identifyLanguageSystemPrompt(): string {
  return [
    'You identify the language ONE secondary-school student in Nigeria wrote their message in.',
    'Answer with exactly one code word and nothing else:',
    'en = English',
    'pcm = Nigerian Pidgin',
    'yo = Yoruba',
    'ha = Hausa',
    'ig = Igbo',
    'If the message is in any other language, or too short or unclear to be sure, answer exactly: unknown',
  ].join('\n');
}
