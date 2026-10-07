import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { buildAiConfig } from './ai.config.js';

function configService(env: Record<string, string>): ConfigService {
  return new ConfigService(env);
}

describe('buildAiConfig — language lane', () => {
  it('defaults the local N-ATLaS timeout to 15s and the model to the Ollama tag', () => {
    const config = buildAiConfig(configService({}));
    expect(config.language.understandingTimeoutMs).toBe(15_000);
    expect(config.language.natlasModel).toBe('natlas:latest');
    expect(config.language.natlasBaseUrl).toBeNull();
  });

  it('honours NATLAS_UNDERSTANDING_TIMEOUT_MS for slow CPU inference', () => {
    const config = buildAiConfig(
      configService({ NATLAS_UNDERSTANDING_TIMEOUT_MS: '120000' }),
    );
    expect(config.language.understandingTimeoutMs).toBe(120_000);
  });

  it('treats an empty timeout as the default (not 0)', () => {
    const config = buildAiConfig(
      configService({ NATLAS_UNDERSTANDING_TIMEOUT_MS: '' }),
    );
    expect(config.language.understandingTimeoutMs).toBe(15_000);
  });

  it('uses the configured model name and base url verbatim', () => {
    const config = buildAiConfig(
      configService({
        NATLAS_LLM_MODEL: 'natlas:latest',
        NATLAS_LLM_BASE_URL: 'http://127.0.0.1:11434',
      }),
    );
    expect(config.language.natlasModel).toBe('natlas:latest');
    expect(config.language.natlasBaseUrl).toBe('http://127.0.0.1:11434');
  });

  it('treats a whitespace-only base url as unconfigured', () => {
    const config = buildAiConfig(
      configService({ NATLAS_LLM_BASE_URL: '   ' }),
    );
    expect(config.language.natlasBaseUrl).toBeNull();
  });
});
