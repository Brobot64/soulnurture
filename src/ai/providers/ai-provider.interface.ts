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
  asyncState?: 'COMPLETE' | 'PENDING_AI' | 'FAILED';
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
