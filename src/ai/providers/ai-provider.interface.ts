export const AI_PROVIDER = Symbol('AI_PROVIDER');

export interface AiGenerationInput {
  systemPrompt: string;
  messages: { role: 'user' | 'assistant' | 'system'; content: string }[];
  language?: string;
  /** Structured-output override (e.g. the session-summary schema). Members
   * that support json_schema use it; others ignore it and the caller
   * validates the raw JSON itself. */
  jsonSchema?: { name: string; strict: boolean; schema: Record<string, unknown> };
}

export interface AiGenerationResult {
  message: string;
  emotion: { detected: string | null; confidence: number | null };
  reflection: { question: string | null; insight: string | null };
  resource: { recommended: boolean; resourceId: string | null };
  humanSupport: {
    recommended: boolean;
    type: string | null;
    reason: string | null;
  };
  supportFlag: {
    candidate: boolean;
    category: string | null;
    severity: string | null;
  };
  action: 'NONE' | 'REFLECTION' | 'GROUNDING' | 'RESOURCE' | 'HUMAN_SUPPORT';
  /** Server extras: set by the intent engine / async pipeline, never by the model. */
  exerciseLabel?: string | null;
  /** Backend-orchestrated activity recommendation (Phase C step 6). Slug
   * references the seeded catalogue; the client fetches steps via the
   * activities API. Not part of the model's structured-output contract. */
  activity?: { recommended: boolean; slug: string | null; title: string | null } | null;
  asyncState?: 'COMPLETE' | 'PENDING_AI' | 'FAILED';
  /** Server-owned: the reply was rendered into a vernacular language by the
   * render lane (n-atlas-translate mode); englishSource keeps the original
   * English text for audit. Null/absent = the reply shipped as generated. */
  render?: { language: string; via: string; englishSource: string } | null;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    latencyMs?: number;
    /** Server-owned: which chain member served this generation (explainability). */
    provider?: string;
  };
}

export interface AiTranscriptionInput {
  buffer: Buffer;
  filename: string;
  mimeType: string;
  language?: string;
}

export interface AiTranscriptionResult {
  text: string;
  durationSeconds?: number;
}

export interface AiProvider {
  generateResponse(input: AiGenerationInput): Promise<AiGenerationResult>;
  transcribeAudio(input: AiTranscriptionInput): Promise<AiTranscriptionResult>;
}
