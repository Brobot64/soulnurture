import { ConfigService } from '@nestjs/config';
import { buildAiConfig } from './ai.config.js';

describe('buildAiConfig guided block', () => {
  it('carries the quick-reply directives and no turn budget', () => {
    const config = buildAiConfig(new ConfigService({}));

    expect(config.guided.directives.TELL_MORE).toContain('Tell more');
    expect(config.guided.directives.SHOW_IDEA).toContain('idea');
    expect(config.guided.directives.TALK_TO_SOMEONE).toContain('counsellor');
    expect(config.guided.flagDirective.toLowerCase()).toContain(
      'safeguarding',
    );
    expect(config.guided).not.toHaveProperty('maxBaseTurns');
    expect(config.guided).not.toHaveProperty('maxExtendedTurns');
    expect(config.guided).not.toHaveProperty('wrapUpDirective');
  });

  it('defaults the check-in end + budget knobs: 180 s idle, 40-message context, 120 turns/day', () => {
    const config = buildAiConfig(new ConfigService({}));

    expect(config.memory.idleMinutes).toBe(3);
    expect(config.context).toEqual({
      messageLimit: 40,
      characterLimit: 30_000,
    });
    expect(config.guardrails.rate.perStudentDaily).toBe(120);
  });

  it('honours AI_SESSION_IDLE_MINUTES / AI_CONTEXT_MESSAGE_LIMIT / AI_RATE_LIMIT_DAILY', () => {
    const config = buildAiConfig(
      new ConfigService({
        AI_SESSION_IDLE_MINUTES: '45',
        AI_CONTEXT_MESSAGE_LIMIT: '20',
        AI_RATE_LIMIT_DAILY: '50',
      }),
    );

    expect(config.memory.idleMinutes).toBe(45);
    expect(config.context.messageLimit).toBe(20);
    expect(config.guardrails.rate.perStudentDaily).toBe(50);
  });
});

describe('buildAiConfig language block', () => {
  it('defaults the reply lane to n-atlas-translate', () => {
    const config = buildAiConfig(new ConfigService({}));

    expect(config.language.vernacularReplyMode).toBe('n-atlas-translate');
    expect(config.language.natlasRenderTimeoutMs).toBe(12_000);
    expect(config.language.renderMaxOutputTokens).toBe(400);
  });

  it('keeps openai-native as an explicit rollback', () => {
    const config = buildAiConfig(
      new ConfigService({ AI_VERNACULAR_REPLY_MODE: 'openai-native' }),
    );

    expect(config.language.vernacularReplyMode).toBe('openai-native');
  });

  it('falls back to the default on an unrecognised mode', () => {
    const config = buildAiConfig(
      new ConfigService({ AI_VERNACULAR_REPLY_MODE: 'bogus' }),
    );

    expect(config.language.vernacularReplyMode).toBe('n-atlas-translate');
  });

  it('honours NATLAS_RENDER_TIMEOUT_MS', () => {
    const config = buildAiConfig(
      new ConfigService({ NATLAS_RENDER_TIMEOUT_MS: '8000' }),
    );

    expect(config.language.natlasRenderTimeoutMs).toBe(8_000);
  });

  it('defaults the language-ID knobs to the strictest budget', () => {
    const config = buildAiConfig(new ConfigService({}));

    expect(config.language.natlasIdentifyTimeoutMs).toBe(4_000);
    expect(config.language.identifyMaxOutputTokens).toBe(64);
  });

  it('honours NATLAS_IDENTIFY_TIMEOUT_MS', () => {
    const config = buildAiConfig(
      new ConfigService({ NATLAS_IDENTIFY_TIMEOUT_MS: '2000' }),
    );

    expect(config.language.natlasIdentifyTimeoutMs).toBe(2_000);
  });
});
