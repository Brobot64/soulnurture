import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsString } from 'class-validator';

/**
 * Every statement of the current disclosure must be ticked — a partial list is
 * not the affirmative action the consent gate requires, so the controller
 * rejects it before anything is written.
 */
export class AcknowledgeDisclosureDto {
  @ApiProperty({
    type: [String],
    example: ['ai-limits', 'ai-mistakes', 'privacy-safeguarding'],
    description: 'Ids of the disclosure statements the student ticked',
  })
  @IsArray()
  @IsString({ each: true })
  agreements!: string[];
}
