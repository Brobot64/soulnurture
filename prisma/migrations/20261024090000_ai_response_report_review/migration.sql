-- CreateEnum + AlterTable: record-only reviewer decision on a reported AI reply.
-- The reported text stays immutable; these columns only say what a same-school
-- reviewer concluded about it. reviewedById is SET NULL so removing a staff
-- account never deletes the decision or the timestamp it was made at.
CREATE TYPE "AiReportReviewOutcome" AS ENUM ('NO_CHANGE_NEEDED', 'FOLLOWED_UP_WITH_STUDENT', 'CANNOT_ASSESS');

ALTER TABLE "ai_response_report"
    ADD COLUMN "reviewOutcome" "AiReportReviewOutcome",
    ADD COLUMN "reviewedById" UUID,
    ADD COLUMN "reviewedAt" TIMESTAMP(3);

ALTER TABLE "ai_response_report" ADD CONSTRAINT "ai_response_report_reviewedById_fkey"
    FOREIGN KEY ("reviewedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
