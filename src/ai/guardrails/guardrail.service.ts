import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AI_CONFIG } from '../config/ai.config.js';
import type { AiConfig } from '../config/ai.config.js';
import type {
  BannedClaimSpec,
  GuardrailsConfig,
  InjectionPatternSpec,
} from './guardrails.config.js';

/**
 * 429 from the rate gate. Shape matches the envelope contract: the global
 * filter maps the status, and `retryAfterSeconds` tells the client (and any
 * future Retry-After header) when the next window opens.
 */
export class RateLimitExceededException extends HttpException {
  constructor(message: string, retryAfterSeconds: number) {
    super(
      { message, retryAfterSeconds },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

export interface SanitizedInput {
  /** What the model sees — truncated, never the intent floor's input. */
  content: string;
  notes: string[];
  injected: boolean;
}

export interface FilteredOutput {
  reply: string;
  notes: string[];
  /** Banned-claim ids that fired (audit/evidence trail). */
  violations: string[];
}

interface CompiledInjection extends InjectionPatternSpec {
  regex: RegExp;
}

interface CompiledClaim extends BannedClaimSpec {
  regexes: RegExp[];
}

interface WindowCounter {
  count: number;
  expiresAt: number;
}

function compile(source: string): RegExp {
  return new RegExp(source, 'i');
}

/** Day bucket in server-local time — matches the AiUsageDaily day semantics. */
function dayBucket(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;
}

@Injectable()
export class GuardrailService {
  private compiledInjections: CompiledInjection[] | null = null;
  private compiledClaims: CompiledClaim[] | null = null;
  private readonly windows = new Map<string, WindowCounter>();

  constructor(@Inject(AI_CONFIG) private readonly aiConfig: AiConfig) {}

  private get config(): GuardrailsConfig {
    return this.aiConfig.guardrails;
  }

  // -- input lane -----------------------------------------------------------

  sanitizeInput(content: string): SanitizedInput {
    const notes: string[] = [];
    const { maxMessageChars, truncationNote } = this.config.input;

    let sanitized = content;
    if (content.length > maxMessageChars) {
      sanitized = content.slice(0, maxMessageChars);
      notes.push(truncationNote);
    }

    const injections = this.injections().filter((probe) => probe.regex.test(content));
    if (injections.length === 0) {
      return { content: sanitized, notes, injected: false };
    }

    notes.push(
      ...injections.map(
        (probe) => `Guardrail flagged probe "${probe.id}": ${probe.note} Probes are ignored; the message is still answered as wellbeing support.`,
      ),
    );
    return { content: sanitized, notes, injected: true };
  }

  /** One-line hardening appended to the system prompt on detected probes. */
  promptHardeningLine(): string {
    return this.config.input.promptHardeningLine;
  }

  // -- output lane ----------------------------------------------------------

  filterOutput(reply: string): FilteredOutput {
    const notes: string[] = [];
    const violations: string[] = [];

    let current = reply;
    const severe = this.claims().find((claim) =>
      claim.severity === 'severe' && claim.regexes.some((regex) => regex.test(current)),
    );
    if (severe) {
      violations.push(severe.id);
      notes.push(
        `Guardrail "${severe.id}" (severe): ${severe.reason} Reply replaced with scripted copy.`,
      );
      current = severe.replacement ?? this.config.output.fallbackCopy;
    } else {
      const softHits = this.claims().filter(
        (claim) =>
          claim.severity === 'soft' && claim.regexes.some((regex) => regex.test(current)),
      );
      if (softHits.length > 0) {
        violations.push(...softHits.map((claim) => claim.id));
        const hitPattern = new RegExp(
          softHits
            .flatMap((claim) => claim.patterns)
            .map((source) => `(?:${source})`)
            .join('|'),
          'i',
        );
        const kept = splitSentences(current).filter(
          (sentence) => !hitPattern.test(sentence),
        );
        notes.push(
          ...softHits.map(
            (claim) => `Guardrail "${claim.id}" (soft): ${claim.reason} Offending sentence(s) stripped.`,
          ),
        );
        current = kept.length > 0 ? kept.join(' ') : this.config.output.fallbackCopy;
      }
    }

    const { maxReplyChars, truncationNote } = this.config.output;
    if (current.length > maxReplyChars) {
      current = `${current.slice(0, maxReplyChars).trimEnd()}…`;
      notes.push(truncationNote);
    }

    return { reply: current, notes, violations };
  }

  // -- rate lane ------------------------------------------------------------

  /**
   * Fixed-window counters per student (server-local). Counts only turns that
   * actually proceed — a rejected turn consumes no budget, so a student can
   * never lock themselves out by retrying during the cool-down. The human
   * support route does not pass through this gate.
   */
  assertMessageAllowed(studentId: string, now: Date = new Date()): void {
    const { perStudentDaily, perStudentPerMinute, limitMessage } = this.config.rate;

    this.pruneExpired(now);

    const dayKey = `day:${studentId}:${dayBucket(now)}`;
    const minuteStart = Math.floor(now.getTime() / 60_000) * 60_000;
    const minuteKey = `min:${studentId}:${minuteStart}`;

    // Peek before committing: a turn that will be rejected must not consume
    // budget in either window (retrying during cool-down can never lock a
    // student out for the rest of the day).
    const dayCount = (this.windows.get(dayKey)?.count ?? 0) + 1;
    if (dayCount > perStudentDaily) {
      throw new RateLimitExceededException(limitMessage, secondsToMidnight(now));
    }
    const minuteCount = (this.windows.get(minuteKey)?.count ?? 0) + 1;
    if (minuteCount > perStudentPerMinute) {
      throw new RateLimitExceededException(limitMessage, 60 - now.getSeconds());
    }

    this.bump(dayKey, 24 * 60 * 60 * 1000);
    this.bump(minuteKey, 2 * 60 * 1000);
  }

  private bump(key: string, ttlMs: number): number {
    const nowMs = Date.now();
    const counter = this.windows.get(key);
    if (!counter || counter.expiresAt <= nowMs) {
      const fresh: WindowCounter = { count: 1, expiresAt: nowMs + ttlMs };
      this.windows.set(key, fresh);
      return fresh.count;
    }
    counter.count += 1;
    return counter.count;
  }

  private pruneExpired(now: Date): void {
    const nowMs = now.getTime();
    for (const [key, counter] of this.windows) {
      if (counter.expiresAt <= nowMs) this.windows.delete(key);
    }
  }

  // -- compiled pattern caches ----------------------------------------------

  private injections(): CompiledInjection[] {
    this.compiledInjections ??= this.config.input.injectionPatterns.map((probe) => ({
      ...probe,
      regex: compile(probe.pattern),
    }));
    return this.compiledInjections;
  }

  private claims(): CompiledClaim[] {
    this.compiledClaims ??= this.config.output.bannedClaims.map((claim) => ({
      ...claim,
      regexes: claim.patterns.map(compile),
    }));
    return this.compiledClaims;
  }
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

function secondsToMidnight(now: Date): number {
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return Math.max(1, Math.round((midnight.getTime() - now.getTime()) / 1000));
}
