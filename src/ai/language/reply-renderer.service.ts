import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AI_CONFIG } from '../config/ai.config.js';
import type { AiConfig } from '../config/ai.config.js';
import { OPENAI_CHAT_URL } from '../providers/openai/openai.constants.js';
import { AiUsageMeterService } from '../providers/usage-meter.service.js';
import { NatlasLlmProvider } from '../providers/natlas/natlas-llm.provider.js';
import { franc } from 'franc';
import {
  DIACRITIC_SETS,
  FRANC_ACCEPTED_CODE,
  FRANC_MIN_CHARS,
  FRANC_ONLY_CODES,
  LEXICON_MIN_SCORE,
  LEXICON_WORDS,
  PIDGIN_MARKER_PHRASES,
  PIDGIN_MARKERS,
  PIDGIN_MIN_MARKERS,
  type SupportedLanguage,
} from './language.config.js';

const LOCAL_CODES = ['yo', 'ha', 'ig'] as const;
import { renderSystemPrompt } from './render.prompt.js';

export interface ReplyRenderInput {
  /** The finished, guardrailed English reply. */
  englishReply: string;
  language: SupportedLanguage;
  /** Short context lines (student's name, what they wrote) so the render
   * keeps pronouns and references right. */
  contextLines?: string[];
}

export interface ReplyRenderOutcome {
  rendered: string;
  via: 'n-atlas-local' | 'openai';
  usage?: { inputTokens?: number; outputTokens?: number; latencyMs?: number };
}

/**
 * Reply-render lane for VERNACULAR_REPLY_015: when the student's turn is in
 * a Nigerian language, the finished English reply is rendered into that
 * language in the same request — the student's next reply comes back in
 * their language immediately. Same chain pattern as the understanding lane
 * (`n-atlas-local` → `openai`) but never throws: rendering is an
 * enhancement, so on total failure the caller keeps the English reply.
 */
@Injectable()
export class ReplyRendererService {
  private readonly logger = new Logger(ReplyRendererService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly natlasLlm: NatlasLlmProvider,
    private readonly meter: AiUsageMeterService,
    @Inject(AI_CONFIG) private readonly aiConfig: AiConfig,
  ) {}

  private get apiKey(): string {
    // Secret lives only here; it never enters AiConfig, which GET /api/v1/ai/config exposes.
    return this.config.get<string>('OPENAI_API_KEY') ?? '';
  }

  async render(input: ReplyRenderInput): Promise<ReplyRenderOutcome | null> {
    const systemPrompt = renderSystemPrompt(input.language);
    const userContent = [
      ...(input.contextLines ?? []),
      'English reply to render:',
      input.englishReply,
    ].join('\n');

    if (this.natlasLlm.configured) {
      try {
        const started = Date.now();
        const completion = await this.natlasLlm.completeText(
          systemPrompt,
          userContent,
        );
        const rendered = cleanRenderedText(completion.text);
        const usage = {
          ...completion.usage,
          latencyMs: Date.now() - started,
        };
        await this.meter.record('n-atlas-local', usage);
        if (isTargetLanguageRender(rendered, input)) {
          return { rendered, via: 'n-atlas-local', usage };
        }
        this.logger.warn('N-ATLaS render was not in the target language; trying OpenAI');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `N-ATLaS render failed; falling back to OpenAI: ${message}`,
        );
      }
    }

    try {
      const outcome = await this.viaOpenAi(systemPrompt, userContent);
      if (isTargetLanguageRender(outcome.rendered, input)) return outcome;
      this.logger.warn('OpenAI render was not in the target language; keeping the scripted reply');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `OpenAI render fallback failed; keeping the English reply: ${message}`,
      );
    }
    return null;
  }

  private async viaOpenAi(
    systemPrompt: string,
    userContent: string,
  ): Promise<ReplyRenderOutcome> {
    if (!this.apiKey) {
      throw new Error('OpenAI render fallback is not configured');
    }
    const started = Date.now();

    let res: Response;
    try {
      res = await fetch(OPENAI_CHAT_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.aiConfig.openai.model,
          max_completion_tokens: this.aiConfig.language.renderMaxOutputTokens,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
          ],
        }),
        signal: AbortSignal.timeout(
          this.aiConfig.language.understandingTimeoutMs,
        ),
      });
    } catch (error) {
      throw new Error('OpenAI render fallback is unreachable', { cause: error });
    }

    if (!res.ok) {
      throw new Error(
        `OpenAI render fallback rejected the request with status ${res.status}`,
      );
    }

    const json = (await res.json().catch((error: unknown) => {
      throw new Error('OpenAI render fallback returned a non-JSON body', {
        cause: error,
      });
    })) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = json.choices?.[0]?.message?.content;
    if (!content || content.trim().length === 0) {
      throw new Error('OpenAI render fallback returned an empty response');
    }

    const rendered = cleanRenderedText(content);
    await this.meter.record('openai', {
      inputTokens: json.usage?.prompt_tokens,
      outputTokens: json.usage?.completion_tokens,
      latencyMs: Date.now() - started,
    });
    return { rendered, via: 'openai' };
  }
}

/**
 * A render counts only when it is actually in the target language:
 *  - it must not simply hand back the English reply, and
 *  - for Yoruba, Hausa and Igbo it must not read as English prose.
 * Pidgin is lexified on English, so for Pidgin only the echo check applies.
 */
export function isTargetLanguageRender(
  rendered: string,
  input: ReplyRenderInput,
): boolean {
  const out = rendered.trim().toLowerCase();
  const english = input.englishReply.trim().toLowerCase();
  if (out.length === 0) return false;
  // Echo: the English comes back whole, possibly behind a label.
  if (out.includes(english)) return false;
  // A translation of a short reply is not many times longer, and does not loop.
  if (out.length > english.length * 2.5 + 40) return false;
  if (hasLoopingPhrase(out)) return false;
  if (
    input.language !== 'pcm' &&
    input.language !== 'en' &&
    out.length >= FRANC_MIN_CHARS &&
    franc(out, { only: [...FRANC_ONLY_CODES] }) === FRANC_ACCEPTED_CODE
  ) {
    return false;
  }
  // Positive evidence for the target: a render that cannot be recognised as the
  // target language is not used (the scripted line is the safe fallback).
  if (!hasTargetEvidence(rendered.toLowerCase(), input.language)) return false;
  // Another local language's EXCLUSIVE diacritics (ọ is shared by Yoruba and
  // Igbo, so it never counts): the render went to the wrong language.
  const lowered = rendered.toLowerCase();
  for (const other of ['yo', 'ha', 'ig'] as const) {
    if (other === input.language) continue;
    const exclusive = DIACRITIC_SETS[other].filter(
      (char) => !LOCAL_CODES.some((code) => code !== other && DIACRITIC_SETS[code].includes(char)),
    );
    if (exclusive.some((char) => lowered.includes(char))) return false;
  }
  return true;
}

/** Weighted lexicon score of one local language in a text (same weights as the
 * detector: 2-letter words count half). */
function lexiconScore(text: string, language: (typeof LOCAL_CODES)[number]): number {
  const words = new Set(LEXICON_WORDS[language]);
  let score = 0;
  for (const token of text.match(/[a-z']+/g) ?? []) {
    if (words.has(token)) score += token.length <= 2 ? 0.5 : 1;
  }
  return score;
}

/** Pidgin: at least two Pidgin markers and no strong local-language reading.
 * Yoruba/Hausa/Igbo: a diacritic or a lexicon word of that language. English
 * needs no evidence. */
function hasTargetEvidence(text: string, language: SupportedLanguage): boolean {
  if (language === 'en') return true;
  if (language === 'pcm') {
    // Two Pidgin markers, and no strong local-language lexicon reading: a
    // single "e don" beside Yoruba words is not a Pidgin reply.
    const tokens = new Set(text.match(/[a-z']+/g) ?? []);
    const markers =
      PIDGIN_MARKERS.filter((m) => tokens.has(m)).length +
      PIDGIN_MARKER_PHRASES.filter((p) => text.includes(p)).length;
    if (markers < PIDGIN_MIN_MARKERS) return false;
    return !LOCAL_CODES.some((code) => lexiconScore(text, code) >= LEXICON_MIN_SCORE);
  }
  if (DIACRITIC_SETS[language].some((char) => text.includes(char))) return true;
  const tokens = new Set(text.match(/[a-z']+/g) ?? []);
  return LEXICON_WORDS[language].some((w) => tokens.has(w));
}

/** Any 4-word phrase appearing three or more times: the model is looping. */
function hasLoopingPhrase(text: string): boolean {
  const words = text.split(/\s+/).filter(Boolean);
  const counts = new Map<string, number>();
  for (let i = 0; i + 4 <= words.length; i++) {
    const phrase = words.slice(i, i + 4).join(' ');
    const n = (counts.get(phrase) ?? 0) + 1;
    if (n >= 3) return true;
    counts.set(phrase, n);
  }
  return false;
}

/** Models occasionally wrap the render in quotes despite instructions. */
function cleanRenderedText(text: string): string {
  // Models sometimes prefix a label ("Nigerian Pidgin reply:") on its own line.
  let out = text
    .trim()
    .replace(/^(?:nigerian pidgin|pidgin|yoruba|hausa|igbo|english)[^\n:]{0,20}:\s*\n?/i, '')
    .trim();
  const quotePairs: [string, string][] = [
    ['"', '"'],
    ["'", "'"],
    ['“', '”'],
    ['‘', '’'],
  ];
  for (const [open, close] of quotePairs) {
    if (out.startsWith(open) && out.endsWith(close) && out.length > 2) {
      out = out.slice(open.length, -close.length).trim();
      break;
    }
  }
  return out;
}
