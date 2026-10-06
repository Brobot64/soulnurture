export class AiGenerationError extends Error {
  constructor(
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = 'AiGenerationError';
    if (options?.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}
