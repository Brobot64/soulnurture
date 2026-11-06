import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/**
 * Deleting a person is not reversible and not covered by the 24-hour undo
 * window — that protects a student's own request, not an admin's decision —
 * so the endpoint carries an explicit confirmation. A UI that fires this by
 * accident has to have said "yes, permanently" first.
 */
export class EraseUserDto {
  @ApiProperty({
    example: true,
    description: 'Must be true: anything else is refused with 422.',
  })
  @IsBoolean()
  confirm!: boolean;
}
