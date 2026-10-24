import { SetMetadata } from '@nestjs/common';

export type AppRole =
  | 'STUDENT'
  | 'COUNSELLOR'
  | 'PSYCHOLOGIST'
  | 'SUPPORT_STAFF'
  | 'SCHOOL_ADMIN'
  | 'PLATFORM_ADMIN';

export const REVIEWER_ROLES = ['COUNSELLOR', 'PSYCHOLOGIST'] as const satisfies readonly AppRole[];

export const ROLES_KEY = 'app_roles';
export const Roles = (...roles: AppRole[]) => SetMetadata(ROLES_KEY, roles);