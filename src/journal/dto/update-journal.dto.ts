import { PartialType } from '@nestjs/swagger';
import { CreateJournalDto } from './create-journal.dto.js';

export class UpdateJournalDto extends PartialType(CreateJournalDto) {}