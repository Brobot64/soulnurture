-- CreateTable: check_in_feedback
-- Post-check-in mood feedback ("how do you feel now?"). One row per check-in
-- (unique checkInId); cascades with the check-in and the student.
CREATE TABLE "check_in_feedback" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "checkInId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "feeling" "FeelingLabel" NOT NULL,
    "intensity" "FeelingIntensity" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "check_in_feedback_pkey" PRIMARY KEY ("id")
);

-- One feedback row per check-in
CREATE UNIQUE INDEX "check_in_feedback_checkInId_key" ON "check_in_feedback"("checkInId");

-- Admin report lookup pattern
CREATE INDEX "check_in_feedback_studentId_createdAt_idx" ON "check_in_feedback"("studentId", "createdAt");

-- AddForeignKey
ALTER TABLE "check_in_feedback" ADD CONSTRAINT "check_in_feedback_checkInId_fkey" FOREIGN KEY ("checkInId") REFERENCES "emotional_check_in"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "check_in_feedback" ADD CONSTRAINT "check_in_feedback_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "student_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
