import { plainToInstance } from 'class-transformer';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  validateSync,
} from 'class-validator';

enum Environment {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

class EnvironmentVariables {
  @IsEnum(Environment)
  NODE_ENV: Environment = Environment.Development;

  @IsNumber()
  PORT: number = 3000;

  @IsString()
  DATABASE_URL!: string;

  @IsString()
  BETTER_AUTH_SECRET!: string;

  @IsUrl({ require_tld: false })
  BETTER_AUTH_URL!: string;

  @IsString()
  ALLOWED_ORIGINS!: string;

  @IsString()
  SMTP_HOST!: string;

  @IsNumber()
  SMTP_PORT!: number;

  @IsString()
  SMTP_USER!: string;

  @IsString()
  SMTP_PASS!: string;

  @IsString()
  MAIL_FROM!: string;

  @IsOptional()
  @IsString()
  GROQ_API_KEY?: string;

  @IsOptional()
  @IsString()
  GROQ_CHAT_MODEL?: string;

  @IsOptional()
  @IsString()
  GROQ_TRANSCRIPTION_MODEL?: string;

  @IsOptional()
  @IsNumber()
  GROQ_MAX_OUTPUT_TOKENS?: number;

  @IsOptional()
  @IsNumber()
  GROQ_TEMPERATURE?: number;

  @IsOptional()
  @IsNumber()
  AI_CONTEXT_MESSAGE_LIMIT?: number;

  @IsOptional()
  @IsNumber()
  AI_CONTEXT_CHARACTER_LIMIT?: number;

  @IsOptional()
  @IsNumber()
  AI_MAX_MESSAGE_CHARS?: number;

  @IsOptional()
  @IsNumber()
  AI_MAX_REPLY_CHARS?: number;

  @IsOptional()
  @IsNumber()
  AI_RATE_LIMIT_DAILY?: number;

  @IsOptional()
  @IsNumber()
  AI_RATE_LIMIT_PER_MINUTE?: number;

  @IsOptional()
  @IsString()
  OPENAI_API_KEY?: string;

  @IsOptional()
  @IsString()
  OPENAI_EMBEDDING_MODEL?: string;

  @IsOptional()
  @IsNumber()
  AI_SESSION_IDLE_MINUTES?: number;

  @IsOptional()
  @IsString()
  OPENAI_CHAT_MODEL?: string;

  @IsOptional()
  @IsNumber()
  OPENAI_MAX_OUTPUT_TOKENS?: number;

  @IsOptional()
  @IsNumber()
  OPENAI_TEMPERATURE?: number;

  @IsOptional()
  @IsString()
  AI_PROVIDER_CHAIN?: string;

  @IsOptional()
  @IsNumber()
  OPENAI_DAILY_REQUEST_CAP?: number;

  @IsOptional()
  @IsNumber()
  OPENAI_INPUT_USD_CENTS_PER_1M?: number;

  @IsOptional()
  @IsNumber()
  OPENAI_OUTPUT_USD_CENTS_PER_1M?: number;

  @IsOptional()
  @IsNumber()
  GROQ_INPUT_USD_CENTS_PER_1M?: number;

  @IsOptional()
  @IsNumber()
  GROQ_OUTPUT_USD_CENTS_PER_1M?: number;

  @IsOptional()
  @IsString()
  AI_LANGUAGE_OFFER_ENABLED?: string;

  @IsOptional()
  @IsString()
  AI_VERNACULAR_REPLY_MODE?: string;

  @IsOptional()
  @IsString()
  NATLAS_LLM_BASE_URL?: string;

  @IsOptional()
  @IsString()
  NATLAS_LLM_MODEL?: string;

  @IsOptional()
  @IsString()
  NATLAS_ASR_BASE_URL?: string;

  @IsOptional()
  @IsNumber()
  NATLAS_ASR_TIMEOUT_MS?: number;

  @IsOptional()
  @IsString()
  S3_ENDPOINT?: string;

  @IsOptional()
  @IsString()
  S3_REGION?: string;

  @IsOptional()
  @IsString()
  S3_BUCKET?: string;

  @IsOptional()
  @IsString()
  S3_ACCESS_KEY?: string;

  @IsOptional()
  @IsString()
  S3_SECRET_KEY?: string;
}

export function validateEnv(config: Record<string, unknown>) {
  const validatedConfig = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validatedConfig, {
    skipMissingProperties: false,
  });

  if (errors.length > 0) {
    throw new Error(`Environment Validation Error:\n${errors.toString()}`);
  }

  return validatedConfig;
}
