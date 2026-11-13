import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AI_CONFIG, type AiConfig } from '../../config/ai.config.js';
import {
  ASR_VERNACULAR_LANGUAGES,
  LANGUAGE_DISPLAY_NAMES,
  type AsrVernacularLanguage,
} from '../../language/language.config.js';

/**
 * ---------------------------------------------------------------------------
 * The hosted Hugging Face Inference Endpoints, seen from the outside.
 *
 * Every vernacular lane rides a replica that scales to zero: the three NCAIR1
 * whisper fine-tunes (one per language, `NATLAS_ASR_URL_<LANG>`) and the
 * N-ATLaS chat endpoint (`NATLAS_LLM_BASE_URL`). A cold replica needs minutes
 * to load its checkpoint — 2.5-3.5 min measured on the ASR endpoints, longer on
 * the L4 — which no student request can wait out. The student path warms one
 * language opportunistically (NAtlasAsrProvider.warmUp); this is the platform
 * owner's lever to bring ALL of them up before a pilot, instead of letting the
 * first voice note eat the wait.
 *
 * Waking uses the data plane only: any request that reaches the endpoint proxy
 * schedules a replica, so a bare GET is enough and no write-scoped Hugging Face
 * token is needed. The same limit follows — through the data plane a 503 cannot
 * be told apart from "configured but broken", so this reports what the endpoint
 * answered, not what its control plane claims.
 *
 * The split matters for the bill: describe() answers from config alone and
 * sends nothing, because reading a dashboard must not start paid GPU. Only
 * probeAll() lets a request out, and it is reachable exclusively through the
 * audited POST.
 *
 * URLs and tokens stay inside this service. AiConfig is public through
 * GET /api/v1/ai/config, so both keys are read through ConfigService here,
 * exactly as the providers read them.
 * ---------------------------------------------------------------------------
 */

/** Generous for a handshake that only has to land: an unresponsive host is
 * reported rather than waited on. */
const PROBE_TIMEOUT_MS = 5_000;

/** What the proxy answers while it is bringing a replica up. */
const WAKING_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export type NatlasEndpointState =
  /** Answered 2xx — a replica served the probe. */
  | 'awake'
  /** The proxy answered with a scheduling status: no replica yet, wake under way. */
  | 'waking'
  /** The HTTP layer answered something else — the host is reachable, a warm
   * replica is not proved (a vLLM container rejects the root path). */
  | 'reached'
  /** No answer at all within the budget. */
  | 'unreachable'
  /** No URL configured, so there is nothing to start. */
  | 'not_configured';

interface EndpointIdentity {
  /** Stable key for the UI: `asr-yo` … and `llm-n-atlas`. */
  id: string;
  purpose: 'asr' | 'llm';
  /** Language code for ASR endpoints; null for the chat endpoint. */
  language: AsrVernacularLanguage | null;
  label: string;
  model: string;
}

export interface NatlasEndpointInfo extends EndpointIdentity {
  configured: boolean;
}

export interface NatlasEndpointStatus extends EndpointIdentity {
  state: NatlasEndpointState;
  httpStatus: number | null;
  latencyMs: number | null;
}

interface Target extends EndpointIdentity {
  url: string;
  apiKey: string;
}

/** url and apiKey live on Target alone: what the admin sees is the identity. */
function identity(target: Target): EndpointIdentity {
  const { url: _url, apiKey: _apiKey, ...rest } = target;
  return rest;
}

@Injectable()
export class NatlasEndpointsService {
  private readonly logger = new Logger(NatlasEndpointsService.name);

  constructor(
    @Inject(AI_CONFIG) private readonly aiConfig: AiConfig,
    private readonly config: ConfigService,
  ) {}

  describe(): NatlasEndpointInfo[] {
    return this.list().map((target) => ({
      ...identity(target),
      configured: target.url.length > 0,
    }));
  }

  /**
   * Ask every configured endpoint in parallel and report what each answered.
   * Asking IS the wake: the GET is the thing that schedules a cold replica.
   */
  async probeAll(): Promise<NatlasEndpointStatus[]> {
    return Promise.all(this.list().map((target) => this.probe(target)));
  }

  private list(): Target[] {
    const { endpoints } = this.aiConfig.transcription.natlas;
    const asrKey = this.config.get<string>('NATLAS_ASR_API_KEY')?.trim() ?? '';
    const targets: Target[] = ASR_VERNACULAR_LANGUAGES.map((language) => ({
      id: `asr-${language}`,
      purpose: 'asr' as const,
      language,
      label: `${LANGUAGE_DISPLAY_NAMES[language]} voice notes`,
      model: 'NCAIR1 whisper-small fine-tune',
      url: (endpoints[language] ?? '').trim(),
      apiKey: asrKey,
    }));

    targets.push({
      id: 'llm-n-atlas',
      purpose: 'llm',
      language: null,
      label: 'N-ATLaS replies',
      model: this.aiConfig.language.natlasModel,
      url: (this.aiConfig.language.natlasBaseUrl ?? '').trim(),
      apiKey: this.config.get<string>('NATLAS_LLM_API_KEY')?.trim() ?? '',
    });

    return targets;
  }

  private async probe(target: Target): Promise<NatlasEndpointStatus> {
    if (!target.url) {
      return {
        ...identity(target),
        state: 'not_configured',
        httpStatus: null,
        latencyMs: null,
      };
    }

    const headers: Record<string, string> = {};
    if (target.apiKey) headers.Authorization = `Bearer ${target.apiKey}`;
    const startedAt = Date.now();

    try {
      const res = await fetch(target.url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      await res.body?.cancel();
      return {
        ...identity(target),
        state: stateFor(res.status),
        httpStatus: res.status,
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      this.logger.warn(
        `Endpoint probe failed (${target.id}): ` +
          (error instanceof Error ? error.message : String(error)),
      );
      return {
        ...identity(target),
        state: 'unreachable',
        httpStatus: null,
        latencyMs: Date.now() - startedAt,
      };
    }
  }
}

function stateFor(status: number): NatlasEndpointState {
  if (status >= 200 && status < 300) return 'awake';
  if (WAKING_STATUSES.has(status)) return 'waking';
  return 'reached';
}
