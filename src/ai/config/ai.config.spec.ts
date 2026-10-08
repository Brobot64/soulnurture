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
