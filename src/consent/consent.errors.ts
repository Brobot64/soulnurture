import { ForbiddenException } from '@nestjs/common';

/** Carried in the error envelope so clients can tell this 403 from an ownership 403. */
export const CONSENT_REQUIRED_CODE = 'CONSENT_REQUIRED';

/**
 * 403 from the AI consent gate: the student has no accepted ConsentRecord for
 * the current disclosure version. The client should show the explanation and
 * let them accept, or decline and return to the wellbeing dashboard.
 */
export class ConsentRequiredException extends ForbiddenException {
  constructor() {
    super({
      message:
        'Please read and accept the Soul Nurture AI explanation before you chat.',
      error: 'Forbidden',
      code: CONSENT_REQUIRED_CODE,
    });
  }
}
