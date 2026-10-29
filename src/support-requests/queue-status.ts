import {
  FollowUpStatus,
  SupportFlagStatus,
  SupportRequestStatus,
  SupportTiming,
} from '@prisma/client';
import type { FollowUp } from '@prisma/client';

/**
 * Review-queue vocabulary for the staff "Support requests" screen
 * (figma PNA-4, node 146:914).
 *
 * A row carries FOUR independent facts and never collapses one into another:
 *
 *   - `requestStatus`  the stored lifecycle (PENDING → ACCEPTED → … →
 *                      COMPLETED). This is the row's status pill: a completed
 *                      request must not read like one that merely started.
 *   - `queueStatus`    the coarse chip split — NEW (nobody has acted) vs
 *                      REVIEWED (a professional has).
 *   - `followUpState`  REQUIRED / COMPLETED / NONE, from the follow-up rows.
 *   - `urgency`        URGENT when the student said they do not feel safe, or
 *                      the request was escalated when it was created.
 *   - `prompt`         an active support flag on the request's conversation
 *                      (the AI or a server policy saw something).
 *
 * The chips are filters, not a partition: a new request with a booked
 * follow-up belongs under "New" AND under "Follow-Up Required", so the chip
 * counts do not sum to "All". What is guaranteed — and what broke when the
 * status was derived by precedence — is that every chip's count comes from the
 * same predicate as `matchesQueueFilter`, so the number on a chip is always
 * the number of rows clicking it shows.
 *
 * CANCELLED requests never enter the queue at all.
 */

export type QueueStatus = 'NEW' | 'REVIEWED';

/** The four chip values accepted by `GET /v1/support-requests/queue?status=`. */
export type QueueFilter =
  QueueStatus | 'FOLLOW_UP_REQUIRED' | 'FOLLOW_UP_COMPLETED';

export const QUEUE_STATUSES: readonly QueueFilter[] = [
  'NEW',
  'REVIEWED',
  'FOLLOW_UP_REQUIRED',
  'FOLLOW_UP_COMPLETED',
];

export type FollowUpState = 'NONE' | 'REQUIRED' | 'COMPLETED';

export type Urgency = 'URGENT' | 'NORMAL';

export type SupportPrompt = 'REVIEW_SUGGESTED' | 'NONE';

/** A row as it is derived: everything the predicates below need. */
export interface QueueRow {
  status: SupportRequestStatus;
  timing: SupportTiming;
  followUps: Pick<FollowUp, 'status'>[];
}

const OPEN_FOLLOW_UPS: FollowUpStatus[] = [
  FollowUpStatus.PENDING,
  FollowUpStatus.SCHEDULED,
];

/** The lifecycle states that mean "a professional has acted on this". */
const ACTED_STATUSES: SupportRequestStatus[] = [
  SupportRequestStatus.ACCEPTED,
  SupportRequestStatus.SCHEDULED,
  SupportRequestStatus.IN_PROGRESS,
  SupportRequestStatus.COMPLETED,
];

const ACTIVE_FLAG_STATUSES: SupportFlagStatus[] = [
  SupportFlagStatus.OPEN,
  SupportFlagStatus.IN_REVIEW,
  SupportFlagStatus.ESCALATED,
];

/**
 * Untouched (`PENDING`) versus escalated-but-still-unactioned: an escalated
 * request is not "reviewed" just because the system raised its level.
 */
export function deriveQueueStatus(request: QueueRow): QueueStatus {
  return ACTED_STATUSES.includes(request.status) ? 'REVIEWED' : 'NEW';
}

/**
 * The student's own words outrank everything: `URGENT_UNSAFE` at creation, or
 * a request still sitting in `ESCALATED`. Timing is kept even after review —
 * a request the student called unsafe stays urgent until it is completed.
 */
export function deriveUrgency(request: QueueRow): Urgency {
  const urgent =
    request.timing === SupportTiming.URGENT_UNSAFE ||
    request.status === SupportRequestStatus.ESCALATED;
  return urgent ? 'URGENT' : 'NORMAL';
}

export function deriveFollowUpState(request: QueueRow): FollowUpState {
  if (request.followUps.some((f) => OPEN_FOLLOW_UPS.includes(f.status))) {
    return 'REQUIRED';
  }
  if (request.followUps.some((f) => f.status === FollowUpStatus.COMPLETED)) {
    return 'COMPLETED';
  }
  return 'NONE';
}

/**
 * One predicate for both the count and the filter, so the two can never
 * disagree again.
 */
export function matchesQueueFilter(
  request: QueueRow,
  filter: QueueFilter,
): boolean {
  if (filter === 'FOLLOW_UP_REQUIRED') {
    return deriveFollowUpState(request) === 'REQUIRED';
  }
  if (filter === 'FOLLOW_UP_COMPLETED') {
    return deriveFollowUpState(request) === 'COMPLETED';
  }
  return deriveQueueStatus(request) === filter;
}

export function isActiveFlagStatus(status: SupportFlagStatus): boolean {
  return ACTIVE_FLAG_STATUSES.includes(status);
}

/** Rolling 7-day window behind the "Completed this week" tile. */
export function isWithinCompletedWeek(completedAt: Date, now: Date): boolean {
  return completedAt.getTime() >= now.getTime() - 7 * 24 * 60 * 60 * 1000;
}
