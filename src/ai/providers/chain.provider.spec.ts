import { ServiceUnavailableException } from '@nestjs/common';
import { AiGenerationError } from '../ai.errors.js';
import type { AiConfig } from '../config/ai.config.js';
import type { AiGenerationResult } from './ai-provider.interface.js';
import {
  ChainedAiProvider,
  type ChainMember,
} from './chain.provider.js';

function modelResult(message: string): AiGenerationResult {
  return {
    message,
    emotion: { detected: null, confidence: null },
    reflection: { question: null, insight: null },
    resource: { recommended: false, resourceId: null },
    humanSupport: { recommended: false, type: null, reason: null },
    supportFlag: { candidate: false, category: null, severity: null },
    action: 'REFLECTION',
  };
}

function member(name: string, overrides: Partial<ChainMember['provider']> = {}) {
  return {
    name,
    provider: {
      generateResponse: vi.fn(),
      transcribeAudio: vi.fn(),
      ...overrides,
    },
  };
}

function makeConfig(overrides: Partial<AiConfig['budget']> = {}): AiConfig {
  return {
    chain: { order: ['openai', 'groq'] },
    budget: { openaiDailyRequestCap: 400, ...overrides },
    pricing: { usdCentsPer1M: {} },
  } as unknown as AiConfig;
}

describe('ChainedAiProvider', () => {
  let meter: {
    record: ReturnType<typeof vi.fn>;
    countFor: ReturnType<typeof vi.fn>;
  };
  let audit: { log: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    meter = { record: vi.fn().mockResolvedValue(1), countFor: vi.fn().mockResolvedValue(0) };
    audit = { log: vi.fn().mockResolvedValue({ id: 'audit-1' }) };
  });

  it('serves from the first healthy member and stamps usage.provider', async () => {
    const openai = member('openai', {
      generateResponse: vi.fn().mockResolvedValue(modelResult('openai reply')),
    });
    const groq = member('groq', {
      generateResponse: vi.fn().mockResolvedValue(modelResult('never reached')),
    });
    const chain = new ChainedAiProvider(
      makeConfig(),
      [openai, groq],
      meter,
      audit,
    );

    const result = await chain.generateResponse({
      systemPrompt: 's',
      messages: [],
    });

    expect(result.message).toBe('openai reply');
    expect(result.usage?.provider).toBe('openai');
    expect(groq.provider.generateResponse).not.toHaveBeenCalled();
    // Metering sees the raw provider usage; the provider stamp happens after.
    expect(meter.record).toHaveBeenCalledWith('openai', undefined);
  });

  it('falls through when a member throws AiGenerationError', async () => {
    const openai = member('openai', {
      generateResponse: vi
        .fn()
        .mockRejectedValue(new AiGenerationError('OpenAI provider is not configured')),
    });
    const groq = member('groq', {
      generateResponse: vi.fn().mockResolvedValue(modelResult('fallback')),
    });
    const chain = new ChainedAiProvider(
      makeConfig(),
      [openai, groq],
      meter,
      audit,
    );

    const result = await chain.generateResponse({
      systemPrompt: 's',
      messages: [],
    });

    expect(result.message).toBe('fallback');
    expect(result.usage?.provider).toBe('groq');
    expect(meter.record).toHaveBeenCalledTimes(1);
  });

  it('throws "All AI providers exhausted" when every member fails', async () => {
    const openai = member('openai', {
      generateResponse: vi
        .fn()
        .mockRejectedValue(new AiGenerationError('down')),
    });
    const groq = member('groq', {
      generateResponse: vi
        .fn()
        .mockRejectedValue(new AiGenerationError('down too')),
    });
    const chain = new ChainedAiProvider(
      makeConfig(),
      [openai, groq],
      meter,
      audit,
    );

    await expect(
      chain.generateResponse({ systemPrompt: 's', messages: [] }),
    ).rejects.toThrow(/exhausted/);
  });

  it('propagates non-AiGenerationError failures without trying the next member', async () => {
    const openai = member('openai', {
      generateResponse: vi.fn().mockRejectedValue(new TypeError('bug')),
    });
    const groq = member('groq', {
      generateResponse: vi.fn().mockResolvedValue(modelResult('never')),
    });
    const chain = new ChainedAiProvider(
      makeConfig(),
      [openai, groq],
      meter,
      audit,
    );

    await expect(
      chain.generateResponse({ systemPrompt: 's', messages: [] }),
    ).rejects.toThrow(TypeError);
    expect(groq.provider.generateResponse).not.toHaveBeenCalled();
  });

  it('skips OpenAI for the rest of the day once the daily cap is crossed', async () => {
    meter.countFor.mockResolvedValue(400); // cap reached
    const openai = member('openai', {
      generateResponse: vi.fn().mockResolvedValue(modelResult('openai reply')),
    });
    const groq = member('groq', {
      generateResponse: vi.fn().mockResolvedValue(modelResult('groq reply')),
    });
    const chain = new ChainedAiProvider(
      makeConfig(),
      [openai, groq],
      meter,
      audit,
    );

    const result = await chain.generateResponse({
      systemPrompt: 's',
      messages: [],
    });

    expect(openai.provider.generateResponse).not.toHaveBeenCalled();
    expect(result.usage?.provider).toBe('groq');
  });

  it('audits ai_budget.paused exactly on the crossing generation', async () => {
    const openai = member('openai', {
      generateResponse: vi.fn().mockResolvedValue(modelResult('openai reply')),
    });
    const groq = member('groq');
    const chain = new ChainedAiProvider(
      makeConfig(),
      [openai, groq],
      meter,
      audit,
    );

    meter.record.mockResolvedValue(400); // this request is the one that hits the cap
    await chain.generateResponse({ systemPrompt: 's', messages: [] });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ai_budget.paused' }),
    );

    audit.log.mockClear();
    meter.record.mockResolvedValue(401); // already past — must not re-fire
    await chain.generateResponse({ systemPrompt: 's', messages: [] });
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('still returns the result when metering fails (fail-open)', async () => {
    meter.record.mockResolvedValue(null);
    const openai = member('openai', {
      generateResponse: vi.fn().mockResolvedValue(modelResult('openai reply')),
    });
    const chain = new ChainedAiProvider(
      makeConfig(),
      [openai],
      meter,
      audit,
    );

    const result = await chain.generateResponse({
      systemPrompt: 's',
      messages: [],
    });

    expect(result.message).toBe('openai reply');
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('routes transcription to the first member that offers it', async () => {
    const openai = member('openai', {
      transcribeAudio: vi
        .fn()
        .mockRejectedValue(
          new ServiceUnavailableException('not offered'),
        ),
    });
    const groq = member('groq', {
      transcribeAudio: vi
        .fn()
        .mockResolvedValue({ text: 'hello', durationSeconds: 1 }),
    });
    const chain = new ChainedAiProvider(
      makeConfig(),
      [openai, groq],
      meter,
      audit,
    );

    const result = await chain.transcribeAudio({
      buffer: Buffer.from('x'),
      filename: 'a.webm',
      mimeType: 'audio/webm',
    });

    expect(result.text).toBe('hello');
    expect(groq.provider.transcribeAudio).toHaveBeenCalledTimes(1);
  });

  it('throws ServiceUnavailableException when no member transcribes', async () => {
    const openai = member('openai', {
      transcribeAudio: vi
        .fn()
        .mockRejectedValue(new ServiceUnavailableException('no')),
    });
    const chain = new ChainedAiProvider(
      makeConfig(),
      [openai],
      meter,
      audit,
    );

    await expect(
      chain.transcribeAudio({
        buffer: Buffer.from('x'),
        filename: 'a.webm',
        mimeType: 'audio/webm',
      }),
    ).rejects.toThrow(ServiceUnavailableException);
  });
});
