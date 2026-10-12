import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { franc } from 'franc';
import { AI_CONFIG } from '../config/ai.config.js';
import {
  containsPhrase,
  normalizeForMatch,
} from '../intents/intent-engine.service.js';
import { VERNACULAR_KEYWORDS } from '../intents/vernacular-keywords.js';
import type { AiConfig } from '../config/ai.config.js';
import { NatlasLlmProvider } from '../providers/natlas/natlas-llm.provider.js';
import { OPENAI_CHAT_URL } from '../providers/openai/openai.constants.js';
import { AiUsageMeterService } from '../providers/usage-meter.service.js';
import { identifyLanguageSystemPrompt } from './identify.prompt.js';
import {
  DIACRITIC_SETS,
  FRANC_ACCEPTED_CODE,
  FRANC_MIN_CHARS,
  FRANC_ONLY_CODES,
  FRANC_TO_LANGUAGE,
  IDENTIFY_MIN_CHARS,
  LEXICON_HIGH_SCORE,
  LEXICON_MIN_SCORE,
  LEXICON_WORDS,
  PIDGIN_HIGH_MARKERS,
  PIDGIN_MARKERS,
  MIXED_MIN_SCORE,
  MIXED_MIN_SHARE,
  MIXED_MIN_TOKENS,
  PIDGIN_MARKER_PHRASES,
  PIDGIN_MIN_MARKERS,
  PIDGIN_SINGLE_MIN_TOKENS,
  PIDGIN_STRONG_MARKERS,
  type SupportedLanguage,
} from './language.config.js';

export type LanguageDetectionMethod =
  | 'diacritics'
  | 'pidgin-markers'
  | 'lexicon'
  | 'keyword'
  | 'lexicon-mixed'
  | 'franc'
  | 'model'
  | 'fallback';

export type LanguageConfidence = 'low' | 'medium' | 'high';

export interface LanguageDetection {
  /** null = no confident signal; callers treat it as "keep the student's
   * current preference". */
  lang: SupportedLanguage | null;
  confidence: LanguageConfidence;
  method: LanguageDetectionMethod;
}

/** The model replies with a "Language: …" header above a "Meaning: …" line
 * (see identify.prompt.ts v2); the parse is tolerant of stray punctuation,
 * codes and spelled-out names. When the header is present it is the ONLY
 * thing parsed — the English meaning text may legitimately contain something
 * that looks like a code ("Yo, I am happy…"). */
const LANGUAGE_LINE_PATTERN = /language\s*:\s*([^\n]+)/i;
const IDENTIFIED_CODE_PATTERN = /\b(en|pcm|yo|ha|ig)\b/;
const LANGUAGE_NAME_ALIASES: ReadonlyArray<[string, SupportedLanguage]> = [
  ['english', 'en'],
  ['pidgin', 'pcm'],
  ['yoruba', 'yo'],
  ['hausa', 'ha'],
  ['igbo', 'ig'],
];

function parseLanguageValue(candidate: string): SupportedLanguage | null {
  // NFD-strip combining marks first: N-ATLaS may name the language with its
  // own diacritics ("Yorùbá", "Èdè Yorùbá") — the ASCII codes are unaffected.
  const lowered = candidate
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const code = lowered.match(IDENTIFIED_CODE_PATTERN);
  if (code) return code[1] as SupportedLanguage;
  for (const [name, lang] of LANGUAGE_NAME_ALIASES) {
    if (lowered.includes(name)) return lang;
  }
  return null;
}

function parseIdentifiedLanguage(raw: string): SupportedLanguage | null {
  const header = raw.match(LANGUAGE_LINE_PATTERN);
  // 'Other'/'French' on the header parses to null — an explicit non-answer
  // is honoured (fallback keeps the preference), never back-filled from the
  // meaning line.
  if (header) return parseLanguageValue(header[1]);
  return parseLanguageValue(raw);
}

/**
 * Realtime language detection for the chat lane. Heuristics first (pure, no
 * I/O): diacritics → Pidgin markers → lexicon → franc. Only when every
 * heuristic is silent does the detector ask N-ATLaS itself to classify the
 * message — the model that answers the student decides their language, so
 * Hausa/Igbo typed without diacritics (invisible to the wordlists) is
 * followed instead of the standing preference winning by default. The model
 * stage is fail-open and strictly capped (see NATLAS_IDENTIFY_TIMEOUT_MS):
 * unconfigured endpoint, short text or any error → heuristic verdict stands.
 *
 * A detected language seeds the reply language for that turn (render lane /
 * direct vernacular reply); the async VERNACULAR job still runs the full
 * understanding pass.
 *
 * Stack, first confident signal wins:
 *   1. Diacritics  — sub-dot/hooked letters are near-proof (handles mixed
 *      messages, where trigram detection is weakest).
 *   2. Pidgin      — wordlist, because franc classifies Pidgin as English.
 *   3. Lexicon     — Yoruba/Hausa/Igbo wordlists with occurrence-weighted
 *      scoring; franc is unusable for these (see language.config.ts).
 *   4. franc       — long English text only; its yo/ha/ig/pcm verdicts are
 *      discarded outright.
 *   5. model       — N-ATLaS translates the message and its language header
 *      is read (short texts skip; see identify.prompt.ts). When N-ATLaS is
 *      unconfigured or down, OpenAI answers the same identify prompt.
 *   6. fallback    — lang null → callers keep the conversation's language
 *      (or the preference on its first turn).
 */
@Injectable()
export class LanguageDetectorService {
  private readonly logger = new Logger(LanguageDetectorService.name);

  constructor(
    private readonly natlasLlm: NatlasLlmProvider,
    private readonly config: ConfigService,
    private readonly meter: AiUsageMeterService,
    @Inject(AI_CONFIG) private readonly aiConfig: AiConfig,
  ) {}

  async detect(text: string): Promise<LanguageDetection> {
    const lowered = text.toLowerCase();
    return (
      this.byDiacritics(lowered) ??
      this.byPidginMarkers(lowered) ??
      this.byLexicon(lowered) ??
      this.byKeyword(lowered) ??
      this.byFranc(text, lowered) ??
      (await this.byModel(text)) ?? {
        lang: null,
        confidence: 'low',
        method: 'fallback',
      }
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
    const words = lowered.match(/[a-z']+/g) ?? [];
    const tokens = new Set(words);
    const hits = new Set<string>();
    for (const marker of PIDGIN_MARKERS) {
      if (tokens.has(marker)) hits.add(marker);
    }
    for (const phrase of PIDGIN_MARKER_PHRASES) {
      if (lowered.includes(phrase)) hits.add(phrase);
    }
    // Two markers, or one Pidgin-only marker in a sentence (not a lone word).
    const strongHit = PIDGIN_STRONG_MARKERS.some((m) => hits.has(m));
    const singleStrong = strongHit && words.length >= PIDGIN_SINGLE_MIN_TOKENS;
    if (hits.size < PIDGIN_MIN_MARKERS && !singleStrong) return null;
    return {
      lang: 'pcm',
      confidence: hits.size >= PIDGIN_HIGH_MARKERS ? 'high' : 'medium',
      method: 'pidgin-markers',
    };
  }

  private byLexicon(lowered: string): LanguageDetection | null {
    const tokens = lowered.match(/[a-z']+/g);
    if (!tokens || tokens.length === 0) return null;

    const { best, score, second } = this.lexiconLeader(tokens);
    if (!best || score < LEXICON_MIN_SCORE || score <= second) return null;
    return {
      lang: best,
      confidence: score >= LEXICON_HIGH_SCORE ? 'high' : 'medium',
      method: 'lexicon',
    };
  }

  /** A vernacular safety phrase names its own language. The keyword packs are
   * the safeguarding vocabulary, so a match there is a language signal even
   * when the lexicon is silent — "Mo fe ku" is Yoruba because of the phrase. */
  private byKeyword(lowered: string): LanguageDetection | null {
    const haystack = normalizeForMatch(lowered);
    for (const entries of Object.values(VERNACULAR_KEYWORDS)) {
      for (const entry of entries) {
        if (containsPhrase(haystack, entry.term)) {
          return { lang: entry.language, confidence: 'medium', method: 'keyword' };
        }
      }
    }
    return null;
  }

  /** Code-switched text (e.g. Hausa with English words): a local language's
   * lexicon hits must make up a real share of the words. Low confidence — it
   * replies in that language for the turn but never becomes the conversation's
   * language (see conversations.service.ts). */
  private byMixedLexicon(lowered: string): LanguageDetection | null {
    const tokens = lowered.match(/[a-z']+/g) ?? [];
    if (tokens.length < MIXED_MIN_TOKENS) return null;

    const { best, score, second } = this.lexiconLeader(tokens);
    if (!best || score < MIXED_MIN_SCORE || score <= second) return null;
    if (score / tokens.length < MIXED_MIN_SHARE) return null;
    return { lang: best, confidence: 'low', method: 'lexicon-mixed' };
  }

  /** Weighted lexicon score per local language; `best` is the strict leader,
   * `second` the runner-up (a tie leaves best ambiguous at the caller). */
  private lexiconLeader(tokens: string[]): {
    best: 'yo' | 'ha' | 'ig' | null;
    score: number;
    second: number;
  } {
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
    return { best, score: best ? scores[best] : 0, second };
  }

  private byFranc(text: string, lowered: string): LanguageDetection | null {
    // Short or Nigerian-language text: franc's verdict would be noise.
    if (text.trim().length < FRANC_MIN_CHARS) return null;
    const code = franc(text, { only: [...FRANC_ONLY_CODES] });
    if (code !== FRANC_ACCEPTED_CODE) return null;
    // English-looking text may still carry local words (code-switching):
    // the mixed read wins only when franc says English, so unmarked local
    // text still goes to the model stage.
    return (
      this.byMixedLexicon(lowered) ?? {
        lang: FRANC_TO_LANGUAGE[code],
        confidence: 'medium',
        method: 'franc',
      }
    );
  }

  /**
   * Model stage — the last resort when every heuristic is silent. N-ATLaS
   * first; when it is unconfigured or errors, OpenAI identifies the language
   * (same header contract, same prompt). Fail-open in every direction: text
   * below IDENTIFY_MIN_CHARS or without letters, no key, any error, or an
   * unparsable answer → null, and the caller keeps the conversation's
   * language (or the preference on the first turn).
   */
  private async byModel(text: string): Promise<LanguageDetection | null> {
    const trimmed = text.trim();
    if (trimmed.length < IDENTIFY_MIN_CHARS) return null;
    if (!/\p{L}/u.test(trimmed)) return null;

    if (this.natlasLlm.configured) {
      try {
        const completion = await this.natlasLlm.completeLabel(
          identifyLanguageSystemPrompt(),
          text,
        );
        const lang = parseIdentifiedLanguage(completion.text);
        return lang ? { lang, confidence: 'medium', method: 'model' } : null;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`N-ATLaS language identification failed: ${message}`);
      }
    }

    const lang = await this.identifyViaOpenAi(text);
    return lang ? { lang, confidence: 'medium', method: 'model' } : null;
  }

  /** OpenAI identify fallback — used only when N-ATLaS cannot answer. */
  private async identifyViaOpenAi(text: string): Promise<SupportedLanguage | null> {
    const apiKey = this.config.get<string>('OPENAI_API_KEY')?.trim();
    if (!apiKey) return null;
    const started = Date.now();
    try {
      const res = await fetch(OPENAI_CHAT_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.aiConfig.openai.model,
          max_completion_tokens: this.aiConfig.language.identifyMaxOutputTokens,
          messages: [
            { role: 'system', content: identifyLanguageSystemPrompt() },
            { role: 'user', content: text },
          ],
        }),
        signal: AbortSignal.timeout(this.aiConfig.language.natlasIdentifyTimeoutMs),
      });
      if (!res.ok) {
        throw new Error(`OpenAI identify rejected with status ${res.status}`);
      }
      const json = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      await this.meter.record('openai', {
        inputTokens: json.usage?.prompt_tokens,
        outputTokens: json.usage?.completion_tokens,
        latencyMs: Date.now() - started,
      });
      return parseIdentifiedLanguage(json.choices?.[0]?.message?.content ?? '');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`OpenAI language identification failed: ${message}`);
      return null;
    }
  }
}
