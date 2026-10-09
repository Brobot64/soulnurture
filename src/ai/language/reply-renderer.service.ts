import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AI_CONFIG } from '../config/ai.config.js';
import type { AiConfig } from '../config/ai.config.js';
import { OPENAI_CHAT_URL } from '../providers/openai/openai.constants.js';
import { AiUsageMeterService } from '../providers/usage-meter.service.js';
import { NatlasLlmProvider } from '../providers/natlas/natlas-llm.provider.js';
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
