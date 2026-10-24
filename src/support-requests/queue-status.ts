import {
  FollowUpStatus,
  SupportFlagStatus,
  SupportRequestStatus,
} from '@prisma/client';
import type { FollowUp } from '@prisma/client';

/**
 * Review-queue vocabulary for the staff "Support requests" screen
 * (figma PNA-4, node 146:914). The schema stores the lifecycle per entity
 * (request status, follow-up status, flag status); the screen shows one
 * queue status per row, derived with this precedence:
 *
 *   1. any follow-up PENDING or SCHEDULED   → FOLLOW_UP_REQUIRED
 *   2. any follow-up COMPLETED (none open)  → FOLLOW_UP_COMPLETED
 *   3. request PENDING or ESCALATED         → NEW
 *   4. otherwise (accepted / scheduled /
 *      in-progress / completed request)     → REVIEWED
 *
 * CANCELLED requests never enter the queue.
 *
 * The "Review suggested" prompt pill is an active support flag
 * (OPEN / IN_REVIEW / ESCALATED) on the request's conversation — the AI
 * (or a server policy) saw something that warrants human review.
 */

export type QueueStatus =
  | 'NEW'
  | 'REVIEWED'
  | 'FOLLOW_UP_REQUIRED'
  | 'FOLLOW_UP_COMPLETED';

export const QUEUE_STATUSES: readonly QueueStatus[] = [
  'NEW',
  'REVIEWED',
  'FOLLOW_UP_REQUIRED',
  'FOLLOW_UP_COMPLETED',
];

export type SupportPrompt = 'REVIEW_SUGGESTED' | 'NONE';

const OPEN_FOLLOW_UPS: FollowUpStatus[] = [
  FollowUpStatus.PENDING,
  FollowUpStatus.SCHEDULED,
];

const ACTIVE_FLAG_STATUSES: SupportFlagStatus[] = [
  SupportFlagStatus.OPEN,
  SupportFlagStatus.IN_REVIEW,
  SupportFlagStatus.ESCALATED,
];

export function deriveQueueStatus(request: {
  status: SupportRequestStatus;
  followUps: Pick<FollowUp, 'status'>[];
}): QueueStatus {
  if (
    request.followUps.some((followUp) => OPEN_FOLLOW_UPS.includes(followUp.status))
  ) {
    return 'FOLLOW_UP_REQUIRED';
  }
  if (
    request.followUps.some(
      (followUp) => followUp.status === FollowUpStatus.COMPLETED,
    )
  ) {
    return 'FOLLOW_UP_COMPLETED';
  }
  if (
    request.status === SupportRequestStatus.PENDING ||
    request.status === SupportRequestStatus.ESCALATED
  ) {
    return 'NEW';
  }
  return 'REVIEWED';
}

export function isActiveFlagStatus(status: SupportFlagStatus): boolean {
  return ACTIVE_FLAG_STATUSES.includes(status);
}

/** Rolling 7-day window behind the "Completed this week" tile. */
export function isWithinCompletedWeek(completedAt: Date, now: Date): boolean {
  return completedAt.getTime() >= now.getTime() - 7 * 24 * 60 * 60 * 1000;
}
