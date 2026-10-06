import { SetMetadata } from '@nestjs/common';

export type AppRole = 'STUDENT' | 'COUNSELLOR' | 'PSYCHOLOGIST' | 'SUPPORT_STAFF';

export const ROLES_KEY = 'app_roles';
export const Roles = (...roles: AppRole[]) => SetMetadata(ROLES_KEY, roles);