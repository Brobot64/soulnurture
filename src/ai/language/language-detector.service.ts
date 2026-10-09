import { Injectable } from '@nestjs/common';
import { franc } from 'franc';
import {
  DIACRITIC_SETS,
  FRANC_ACCEPTED_CODE,
  FRANC_MIN_CHARS,
  FRANC_ONLY_CODES,
  FRANC_TO_LANGUAGE,
  LEXICON_HIGH_SCORE,
  LEXICON_MIN_SCORE,
  LEXICON_WORDS,
  PIDGIN_HIGH_MARKERS,
  PIDGIN_MARKERS,
  PIDGIN_MARKER_PHRASES,
  PIDGIN_MIN_MARKERS,
  type SupportedLanguage,
} from './language.config.js';

export type LanguageDetectionMethod =
  | 'diacritics'
  | 'pidgin-markers'
  | 'lexicon'
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
 * sendMessage. A detected vernacular language seeds the reply language for
 * that turn (render lane / direct vernacular reply); the async VERNACULAR
 * job still runs the full understanding pass.
 *
 * Stack, first confident signal wins:
 *   1. Diacritics  — sub-dot/hooked letters are near-proof (handles mixed
 *      messages, where trigram detection is weakest).
 *   2. Pidgin      — wordlist, because franc classifies Pidgin as English.
 *   3. Lexicon     — Yoruba/Hausa/Igbo wordlists with occurrence-weighted
 *      scoring; franc is unusable for these (see language.config.ts).
 *   4. franc       — long English text only; its yo/ha/ig/pcm verdicts are
 *      discarded outright.
 *   5. fallback    — lang null → callers keep the current preference.
 */
@Injectable()
export class LanguageDetectorService {
  detect(text: string): LanguageDetection {
    const lowered = text.toLowerCase();
    return (
      this.byDiacritics(lowered) ??
      this.byPidginMarkers(lowered) ??
      this.byLexicon(lowered) ??
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

  private byLexicon(lowered: string): LanguageDetection | null {
    const tokens = lowered.match(/[a-z']+/g);
    if (!tokens || tokens.length === 0) return null;

    const scores: Record<'yo' | 'ha' | 'ig', number> = { yo: 0, ha: 0, ig: 0 };
    for (const lang of ['yo', 'ha', 'ig'] as const) {
      const words = new Set(LEXICON_WORDS[lang]);
      for (const token of tokens) {
        if (words.has(token)) {
          scores[lang] += token.length <= 2 ? 0.5 : 1;
        }
      }
    }

    let best: 'yo' | 'ha' | 'ig' | null = null;
    let second = 0;
    for (const lang of ['yo', 'ha', 'ig'] as const) {
      if (!best || scores[lang] > scores[best]) {
        second = best ? scores[best] : 0;
        best = lang;
      } else if (scores[lang] > second) {
        second = scores[lang];
      }
    }
    if (!best || scores[best] < LEXICON_MIN_SCORE || scores[best] <= second) {
      return null;
    }
    return {
      lang: best,
      confidence: scores[best] >= LEXICON_HIGH_SCORE ? 'high' : 'medium',
      method: 'lexicon',
    };
  }

  private byFranc(text: string): LanguageDetection {
    // Short or Nigerian-language text: franc's verdict would be noise.
    if (text.trim().length < FRANC_MIN_CHARS) {
      return { lang: null, confidence: 'low', method: 'fallback' };
    }
    const code = franc(text, { only: [...FRANC_ONLY_CODES] });
    if (code !== FRANC_ACCEPTED_CODE) {
      return { lang: null, confidence: 'low', method: 'fallback' };
    }
    return {
      lang: FRANC_TO_LANGUAGE[code],
      confidence: 'medium',
      method: 'franc',
    };
  }
}
