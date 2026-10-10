import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export const QUICK_REPLY_VALUES = [
  'TELL_MORE',
  'SHOW_IDEA',
  'TALK_TO_SOMEONE',
] as const;
export type QuickReplyValue = (typeof QUICK_REPLY_VALUES)[number];

export class SendMessageDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  content!: string;

  /** Deprecated and ignored: the reply language is detected from `content`
   * itself, per turn. Accepted — not rejected — only so clients built
   * against the old contract keep working under `forbidNonWhitelisted`. */
  @ApiPropertyOptional({ example: 'en', deprecated: true })
  @IsOptional()
  @IsString()
  language?: string;

  /** Guided-reply marker: the student tapped a quick reply instead of typing
   * free text. The label is sent as `content`; this marker drives the reply
   * directive and is excluded from the free-text turn budget — though every
   * tap still counts toward the hard total turn cap. */
  @ApiPropertyOptional({ enum: QUICK_REPLY_VALUES })
  @IsOptional()
  @IsIn(QUICK_REPLY_VALUES)
  quickReply?: QuickReplyValue;

  /** Set when the student spoke this turn and the client posts the
   * transcription (the transcript itself rides `content`). Feeds the pilot
   * voice-interaction analytics; reply behaviour is unaffected. */
  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  viaVoice?: boolean;
}
