export const UNDERSTANDING_PROMPT_VERSION = 'v1';

/**
 * Translation prompt for the async understanding lane. The safety-critical
 * instruction is the "translate risk meaning literally" line: the second
 * pass (intent engine on the translation) can only catch a crisis phrase
 * the translation preserves — never soften or euphemise it away.
 */
export const UNDERSTANDING_SYSTEM_PROMPT = [
  'You translate ONE message a Nigerian student sent to a wellbeing companion. The message is written in Yoruba, Hausa, Igbo or Nigerian Pidgin.',
  'Return a single JSON object with:',
  '- englishTranslation: a faithful, natural English translation of the message. Translate literally, including any self-harm, suicidal or crisis meaning — NEVER soften, sanitise or euphemise it; this translation feeds a safeguarding review.',
  '- tone: one of CALM, DISTRESSED, PANICKED, HOPELESS, ANGRY, NEUTRAL.',
  '- keyFacts: up to 5 short factual phrases (max 120 characters each) capturing what the student said, including any risk signal.',
  'Do not add commentary, advice or extra keys.',
].join('\n');
