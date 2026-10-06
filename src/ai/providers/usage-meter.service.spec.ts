import type { AiConfig } from '../config/ai.config.js';
import { AiUsageMeterService } from './usage-meter.service.js';

function makeConfig(): AiConfig {
  return {
    pricing: {
      usdCentsPer1M: {
        openai: { input: 15, output: 60 },
        groq: { input: 10, output: 30 },
      },
    },
  } as unknown as AiConfig;
}

describe('AiUsageMeterService', () => {
  let prisma: { $queryRaw: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    prisma = { $queryRaw: vi.fn() };
  });

  it('upserts one request with token deltas and estimated cents', async () => {
    prisma.$queryRaw.mockResolvedValue([{ requests: 7 }]);
    const meter = new AiUsageMeterService(prisma as never, makeConfig());

    // 2M in @ 15c + 0.5M out @ 60c = 30 + 30 = 60 cents.
    const count = await meter.record('openai', {
      inputTokens: 2_000_000,
      outputTokens: 500_000,
    });

    expect(count).toBe(7);
    const call = prisma.$queryRaw.mock.calls[0];
    const sql = (call[0] as unknown as TemplateStringsArray).join(' ');
    expect(sql).toContain('CURRENT_DATE');
    expect(sql).toContain('ON CONFLICT (day, provider)');
    expect(call[1]).toBe('openai');
    expect(call[2]).toBe(2_000_000);
    expect(call[3]).toBe(500_000);
    expect(call[4]).toBe(60);
  });

  it('estimates zero cents for an unpriced provider instead of failing', async () => {
    prisma.$queryRaw.mockResolvedValue([{ requests: 1 }]);
    const meter = new AiUsageMeterService(prisma as never, makeConfig());

    const count = await meter.record('n-atlas', { inputTokens: 100 });

    expect(count).toBe(1);
    expect(prisma.$queryRaw.mock.calls[0][4]).toBe(0);
  });

  it('counts a generation with no usage payload as a request with zero tokens', async () => {
    prisma.$queryRaw.mockResolvedValue([{ requests: 3 }]);
    const meter = new AiUsageMeterService(prisma as never, makeConfig());

    const count = await meter.record('groq', undefined);

    expect(count).toBe(3);
    expect(prisma.$queryRaw.mock.calls[0][2]).toBe(0);
    expect(prisma.$queryRaw.mock.calls[0][4]).toBe(0);
  });

  it('fails open with null when the upsert errors', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('db down'));
    const meter = new AiUsageMeterService(prisma as never, makeConfig());

    await expect(
      meter.record('openai', { inputTokens: 10 }),
    ).resolves.toBeNull();
  });

  it('reads today’s count for a provider, defaulting to zero without a row', async () => {
    const meter = new AiUsageMeterService(prisma as never, makeConfig());

    prisma.$queryRaw.mockResolvedValue([{ requests: 42 }]);
    await expect(meter.countFor('openai')).resolves.toBe(42);

    prisma.$queryRaw.mockResolvedValue([]);
    await expect(meter.countFor('groq')).resolves.toBe(0);
  });

  it('fails open with null when the count read errors', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('db down'));
    const meter = new AiUsageMeterService(prisma as never, makeConfig());

    await expect(meter.countFor('openai')).resolves.toBeNull();
  });
});
