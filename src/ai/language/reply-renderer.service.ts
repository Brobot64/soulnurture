import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AI_CONFIG } from '../config/ai.config.js';
import type { AiConfig } from '../config/ai.config.js';
import { OPENAI_CHAT_URL } from '../providers/openai/openai.constants.js';
import { AiUsageMeterService } from '../providers/usage-meter.service.js';
import { NatlasLlmProvider } from '../providers/natlas/natlas-llm.provider.js';
import { LanguageDetectorService } from './language-detector.service.js';
import type { SupportedLanguage } from './language.config.js';
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
  /** Heuristic output check: true when the detector either agreed with the
   * requested language or stayed silent; false when it confidently read a
   * DIFFERENT language (typically an un-translated English reply). */
  verified: boolean;
  /** Which render attempt produced this text (1, or 2 after a mismatched
   * first attempt triggered the single retry). */
  attempts: number;
  usage?: { inputTokens?: number; outputTokens?: number; latencyMs?: number };
}

type RenderAttempt = Omit<ReplyRenderOutcome, 'verified' | 'attempts'>;

/**
 * Reply-render lane for VERNACULAR_REPLY_015: when the student's turn is in
 * a Nigerian language, the finished English reply is rendered into that
 * language in the same request — the student's next reply comes back in
 * their language immediately. Same chain pattern as the understanding lane
 * (`n-atlas-local` → `openai`) but never throws: rendering is an
 * enhancement, so on total failure the caller keeps the English reply.
 *
 * VERNACULAR_SAFETY_017 adds an output verification: every render is checked
 * by the heuristics-only detector (no model call), and a confident read of a
 * different language — typically the model echoing the English input —
 * triggers one retry. The latest best-effort render is kept regardless:
 * a possibly-mismatched vernacular reply still beats no reply, and the
 * caller records `verified` for audit.
 */
@Injectable()
export class ReplyRendererService {
  private readonly logger = new Logger(ReplyRendererService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly natlasLlm: NatlasLlmProvider,
    private readonly meter: AiUsageMeterService,
    private readonly languageDetector: LanguageDetectorService,
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

    let best: ReplyRenderOutcome | null = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const outcome = await this.attempt(systemPrompt, userContent);
      // No lane produced anything: retrying the same broken chain adds
      // latency, not a reply. Keep the previous attempt (if any).
      if (!outcome) break;

      const detection = await this.languageDetector.detect(outcome.rendered, {
        allowModel: false,
      });
      const verified =
        detection.lang === null || detection.lang === input.language;
      best = { ...outcome, verified, attempts: attempt };
      if (verified) return best;

      this.logger.warn(
        `Render verification: attempt ${attempt} reads as ${detection.lang} (${detection.method}) but ${input.language} was requested.` +
          (attempt === 1
            ? ' Retrying once.'
            : ' Keeping the best-effort render.'),
      );
    }
    return best;
  }

  private async attempt(
    systemPrompt: string,
    userContent: string,
  ): Promise<RenderAttempt | null> {
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
        return { rendered, via: 'n-atlas-local', usage };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `N-ATLaS render failed; falling back to OpenAI: ${message}`,
        );
      }
    }

    try {
      return await this.viaOpenAi(systemPrompt, userContent);
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
  ): Promise<RenderAttempt> {
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

/** Models occasionally wrap the render in quotes despite instructions. */
function cleanRenderedText(text: string): string {
  let out = text.trim();
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
