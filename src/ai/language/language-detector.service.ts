import { Injectable } from '@nestjs/common';
import { franc } from 'franc';
import {
  DIACRITIC_SETS,
  FRANC_ONLY_CODES,
  FRANC_TO_LANGUAGE,
  PIDGIN_HIGH_MARKERS,
  PIDGIN_MARKERS,
  PIDGIN_MARKER_PHRASES,
  PIDGIN_MIN_MARKERS,
  type SupportedLanguage,
} from './language.config.js';

export type LanguageDetectionMethod =
  | 'diacritics'
  | 'pidgin-markers'
  | 'franc'
  | 'fallback';

export type LanguageConfidence = 'low' | 'medium' | 'high';

export interface LanguageDetection {
  /** null = no confident signal; callers treat it as "keep the student's
   * current preference". */
  lang: SupportedLanguage | null;
  confidence: LanguageConfidence;
  method: LanguageDetectionMethod;
}

/**
 * Realtime, offline language detection for the chat lane. Pure heuristics —
 * no network, no model, no I/O — so it can run synchronously inside
 * sendMessage. Detection drives the first-time languageOffer and the async
 * VERNACULAR job; it never gates the reply language (that stays
 * dto.language ?? preferredLanguage).
 *
 * Stack, first confident signal wins:
 *   1. Diacritics  — sub-dot/hooked letters are near-proof (handles mixed
 *      messages, where trigram detection is weakest).
 *   2. Pidgin      — wordlist, because franc classifies Pidgin as English.
 *   3. franc       — trigram detection restricted to our five languages.
 *   4. fallback    — lang null → callers keep the current preference.
 */
@Injectable()
export class LanguageDetectorService {
  detect(text: string): LanguageDetection {
    const lowered = text.toLowerCase();
    return (
      this.byDiacritics(lowered) ??
      this.byPidginMarkers(lowered) ??
      this.byFranc(text)
    );
  }

  private byDiacritics(lowered: string): LanguageDetection | null {
    let best: { lang: 'yo' | 'ha' | 'ig'; count: number } | null = null;
    let tied = false;
    for (const lang of ['yo', 'ha', 'ig'] as const) {
      let count = 0;
      for (const char of DIACRITIC_SETS[lang]) {
        count += lowered.split(char).length - 1;
      }
      if (count === 0) continue;
      if (!best || count > best.count) {
        best = { lang, count };
        tied = false;
      } else if (count === best.count) {
        tied = true;
      }
    }
    // Ties (e.g. 'ọ' alone) are genuinely ambiguous — fall through.
    if (!best || tied) return null;
    return { lang: best.lang, confidence: 'high', method: 'diacritics' };
  }

  private byPidginMarkers(lowered: string): LanguageDetection | null {
    const tokens = new Set(lowered.match(/[a-z']+/g) ?? []);
    const hits = new Set<string>();
    for (const marker of PIDGIN_MARKERS) {
      if (tokens.has(marker)) hits.add(marker);
    }
    for (const phrase of PIDGIN_MARKER_PHRASES) {
      if (lowered.includes(phrase)) hits.add(phrase);
    }
    if (hits.size < PIDGIN_MIN_MARKERS) return null;
    return {
      lang: 'pcm',
      confidence: hits.size >= PIDGIN_HIGH_MARKERS ? 'high' : 'medium',
      method: 'pidgin-markers',
    };
  }

  private byFranc(text: string): LanguageDetection {
    const code = franc(text, { only: [...FRANC_ONLY_CODES] });
    const lang = FRANC_TO_LANGUAGE[code];
    if (!lang) return { lang: null, confidence: 'low', method: 'fallback' };
    return { lang, confidence: 'medium', method: 'franc' };
  }
}
