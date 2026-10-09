import {
  LANGUAGE_DISPLAY_NAMES,
  type SupportedLanguage,
} from './language.config.js';

export const RENDER_PROMPT_VERSION = 'v1';

/**
 * Render prompt for the n-atlas-translate reply lane. The generation lane
 * (OpenAI chain) writes the finished, guardrailed English reply; N-ATLaS
 * renders it into the turn's language. Faithfulness is the whole contract —
 * the renderer must never add advice, questions or facts, and must never
 * soften safety wording (same rule as the understanding prompt: the text it
 * transforms already passed the guardrail + intent layers in English).
 */
export function renderSystemPrompt(language: SupportedLanguage): string {
  const name = LANGUAGE_DISPLAY_NAMES[language];
  return [
    `You render ONE English reply that a wellbeing companion wrote to a Nigerian secondary-school student into ${name}.`,
    `Output ONLY the ${name} text — no quotes, no labels, no commentary, no English preamble.`,
    `Render faithfully: keep the full meaning, tone and warmth. Do NOT add advice, questions, facts or greetings that are not in the English text.`,
    `Translate literally, including any safety, distress or crisis wording — NEVER soften, sanitise or euphemise it.`,
    `Write natural, everyday ${name} a student in Nigeria would speak; keep the student's own words where the reply quotes them.`,
  ].join('\n');
}

/**
 * Interim system-prompt directive for the generation lane while the render
 * mode is on: the reply is composed in English and rendered afterwards, so
 * asking the frontier model for vernacular here would double-translate.
 */
export function interimEnglishDirective(
  replyLanguage: SupportedLanguage,
): string {
  const name = LANGUAGE_DISPLAY_NAMES[replyLanguage];
  return (
    `Language: write this reply in English. ` +
    `It will be rendered into ${name} by the local model afterwards — keep it clear, warm and simple so the rendering stays natural.`
  );
}
