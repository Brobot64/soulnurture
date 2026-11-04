-- Epic H "Ask to delete your history?" — a student's removal REQUEST, stored as
-- asked and acted on by nobody in code. Entirely additive: one new enum, one new
-- table, no column touched on any existing row, so every current read, dashboard
-- tile and safeguarding path behaves exactly as it does today.
--
-- The row keeps the ask verbatim (scope, the date or the check-in ids, the
-- student's own note) so a later human decision is made against what was
-- actually requested rather than against a paraphrase. "alertedAt" is nullable
-- on purpose: a null means no reviewer was ever told, which the student's
-- receipt must be able to say instead of promising a review that will not come.

-- CreateEnum
CREATE TYPE "HistoryDeletionScope" AS ENUM ('ALL_HISTORY', 'BEFORE_DATE', 'SELECTED_CHECK_INS');

-- CreateTable
CREATE TABLE "history_deletion_request" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "scope" "HistoryDeletionScope" NOT NULL,
    "beforeDate" DATE,
    "checkInIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "note" VARCHAR(2000),
    "alertedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "history_deletion_request_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "history_deletion_request_studentId_createdAt_idx" ON "history_deletion_request"("studentId", "createdAt");

-- AddForeignKey
ALTER TABLE "history_deletion_request" ADD CONSTRAINT "history_deletion_request_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "student_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
