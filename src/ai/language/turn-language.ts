import { SUPPORTED_LANGUAGES, type SupportedLanguage } from './language.config.js';

export interface TurnLanguageInput {
  /** Detector verdict for THIS message; null = silent. */
  detected: SupportedLanguage | null;
  /** Last confident language used in this conversation. */
  conversationLanguage: string | null | undefined;
  /** The student's standing preference. */
  preferredLanguage: string | null | undefined;
}

function asSupported(code: string | null | undefined): SupportedLanguage | null {
  return code && SUPPORTED_LANGUAGES.includes(code as SupportedLanguage)
    ? (code as SupportedLanguage)
    : null;
}

/**
 * The reply language for one student turn. Strict priority:
 *
 *   1. the language detected in THIS message (English included — a confident
 *      English message switches the conversation back to English);
 *   2. the conversation's last confident language — a silent message ("ok",
 *      short or unmarked text) continues the language the student is using,
 *      it does not snap back to the standing preference;
 *   3. the student's preference, only when the conversation has no language
 *      yet (silent first turn);
 *   4. English.
 */
export function resolveTurnLanguage(input: TurnLanguageInput): SupportedLanguage {
  return (
    input.detected ??
    asSupported(input.conversationLanguage) ??
    asSupported(input.preferredLanguage) ??
    'en'
  );
}
