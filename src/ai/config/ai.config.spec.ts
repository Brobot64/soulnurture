import { ConfigService } from '@nestjs/config';
import { buildAiConfig } from './ai.config.js';

describe('buildAiConfig guided block', () => {
  it('defaults to 3 base / 5 extended turns with the TELL_MORE extension', () => {
    const config = buildAiConfig(new ConfigService({}));

    expect(config.guided.maxBaseTurns).toBe(3);
    expect(config.guided.maxExtendedTurns).toBe(5);
    expect(config.guided.extension).toBe('TELL_MORE');
    expect(config.guided.directives.TELL_MORE).toContain('Tell more');
    expect(config.guided.directives.SHOW_IDEA).toContain('idea');
    expect(config.guided.directives.TALK_TO_SOMEONE).toContain('counsellor');
    expect(config.guided.wrapUpDirective).toContain('final turn');
    expect(config.guided.flagDirective.toLowerCase()).toContain(
      'safeguarding',
    );
  });

  it('honours AI_GUIDED_MAX_BASE_TURNS / AI_GUIDED_MAX_EXTENDED_TURNS overrides', () => {
    const config = buildAiConfig(
      new ConfigService({
        AI_GUIDED_MAX_BASE_TURNS: '4',
        AI_GUIDED_MAX_EXTENDED_TURNS: '7',
      }),
    );

    expect(config.guided.maxBaseTurns).toBe(4);
    expect(config.guided.maxExtendedTurns).toBe(7);
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
    expect(config.language.identifyMaxOutputTokens).toBe(8);
  });

  it('honours NATLAS_IDENTIFY_TIMEOUT_MS', () => {
    const config = buildAiConfig(
      new ConfigService({ NATLAS_IDENTIFY_TIMEOUT_MS: '2000' }),
    );

    expect(config.language.natlasIdentifyTimeoutMs).toBe(2_000);
  });
});
