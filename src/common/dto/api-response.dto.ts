import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ApiSuccessResponseDto<T = unknown> {
  @ApiProperty({ example: true })
  success!: true;

  @ApiProperty({ example: 200 })
  statusCode!: number;

  @ApiProperty({ example: 'Request successful' })
  message!: string;

  @ApiProperty({ description: 'Endpoint payload' })
  data!: T;

  @ApiProperty({ example: '/api/users/me' })
  path!: string;

  @ApiProperty({ example: '2026-03-24T12:00:00.000Z' })
  timestamp!: string;
}

export class ApiErrorResponseDto {
  @ApiProperty({ example: false })
  success!: false;

  @ApiProperty({ example: 400 })
  statusCode!: number;

  @ApiProperty({
    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
    example: 'Validation failed',
  })
  message!: string | string[];

  @ApiProperty({ example: 'Bad Request' })
  error!: string;

  @ApiProperty({ example: '/api/check-ins' })
  path!: string;

  @ApiProperty({ example: '2026-03-24T12:00:00.000Z' })
  timestamp!: string;
}

export class PaginationMetaDto {
  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  limit!: number;

  @ApiProperty({ example: 42 })
  total!: number;

  @ApiProperty({ example: 3 })
  totalPages!: number;
}

export class PaginatedDataDto<T = unknown> {
  @ApiProperty({ isArray: true })
  items!: T[];

  @ApiProperty({ type: PaginationMetaDto })
  meta!: PaginationMetaDto;
}

export class MessageDataDto {
  @ApiProperty({ example: 'Verification email sent if the account exists.' })
  message!: string;
}

export class AuthHealthDataDto {
  @ApiProperty({ example: true })
  authenticated!: boolean;

  @ApiProperty({ example: 'auth' })
  service!: string;
}

export class UserDto {
  @ApiProperty({ format: 'uuid', example: '8f3c2a1e-4b5d-6e7f-8091-a2b3c4d5e6f7' })
  id!: string;

  @ApiProperty({ example: 'Amina Okonkwo' })
  name!: string;

  @ApiProperty({ example: 'amina@school.edu' })
  email!: string;

  @ApiProperty({ example: true })
  emailVerified!: boolean;

  @ApiPropertyOptional({ example: '+2348012345678', nullable: true })
  phone?: string | null;

  @ApiPropertyOptional({ example: 'https://cdn.example.com/avatars/amina.jpg', nullable: true })
  image?: string | null;

  @ApiProperty({ example: '2026-03-01T10:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ example: '2026-03-20T08:30:00.000Z' })
  updatedAt!: string;
}

export class SessionDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty()
  token!: string;

  @ApiProperty({ example: '2026-03-31T10:00:00.000Z' })
  expiresAt!: string;

  @ApiPropertyOptional({ nullable: true })
  ipAddress?: string | null;

  @ApiPropertyOptional({ nullable: true })
  userAgent?: string | null;

  @ApiProperty()
  createdAt!: string;

  @ApiProperty()
  updatedAt!: string;
}

export class UserSessionDto {
  @ApiProperty({ type: UserDto })
  user!: UserDto;

  @ApiProperty({ type: SessionDto })
  session!: SessionDto;
}
