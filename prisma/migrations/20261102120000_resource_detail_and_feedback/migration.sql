-- Doc B resource detail template (US-WR-D03/D04), the register code linkage and
-- the §5 "what next?" answer (US-WR-D06). Entirely additive: one new enum, one
-- new table, nullable/empty-default columns on wellbeing_resource and
-- wellbeing_activity. No existing column, index, row or FK is altered, so every
-- pre-Epic-D resource and activity keeps serving exactly as it does today.

-- CreateEnum
CREATE TYPE "ResourceFeedbackChoice" AS ENUM ('NOT_HELPFUL', 'TRY_SOMETHING_ELSE', 'WANT_TO_TALK', 'DECLINED');

-- AlterTable
ALTER TABLE "wellbeing_resource" ADD COLUMN "contentCode" TEXT, ADD COLUMN "intendedSituation" TEXT, ADD COLUMN "instructions" TEXT[] DEFAULT ARRAY[]::TEXT[], ADD COLUMN "reflectionPrompt" TEXT, ADD COLUMN "safetyNote" TEXT;

-- AlterTable
ALTER TABLE "wellbeing_activity" ADD COLUMN "contentCode" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "wellbeing_resource_contentCode_key" ON "wellbeing_resource"("contentCode");

-- CreateIndex
CREATE UNIQUE INDEX "wellbeing_activity_contentCode_key" ON "wellbeing_activity"("contentCode");

-- CreateTable
CREATE TABLE "resource_feedback" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "resourceId" UUID NOT NULL,
    "choice" "ResourceFeedbackChoice" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resource_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "resource_feedback_resourceId_createdAt_idx" ON "resource_feedback"("resourceId", "createdAt");

-- CreateIndex
CREATE INDEX "resource_feedback_studentId_createdAt_idx" ON "resource_feedback"("studentId", "createdAt");

-- AddForeignKey
ALTER TABLE "resource_feedback" ADD CONSTRAINT "resource_feedback_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "student_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_feedback" ADD CONSTRAINT "resource_feedback_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "wellbeing_resource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
