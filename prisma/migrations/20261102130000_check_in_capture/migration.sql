-- Doc C expanded check-in capture (EMO multi-select, CP-03…08/18/20 answers).
-- Entirely additive: one new enum, two new tables, no change to
-- emotional_check_in — so every existing read, dashboard tile, intent path and
-- CheckInFeedback row behaves exactly as it does today.

-- CreateEnum
CREATE TYPE "CheckInAnswerState" AS ENUM ('ANSWERED', 'SKIPPED', 'PREFER_NOT_TO_SAY', 'NOT_PRESENTED');

-- CreateTable
CREATE TABLE "check_in_feeling_selection" (
    "id" UUID NOT NULL,
    "checkInId" UUID NOT NULL,
    "termCode" TEXT,
    "termLabelSnapshot" TEXT NOT NULL,
    "isStudentFreeText" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "check_in_feeling_selection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "check_in_answer" (
    "id" UUID NOT NULL,
    "checkInId" UUID NOT NULL,
    "promptCode" TEXT NOT NULL,
    "state" "CheckInAnswerState" NOT NULL,
    "valueCode" TEXT,
    "freeText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "check_in_answer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "check_in_feeling_selection_checkInId_idx" ON "check_in_feeling_selection"("checkInId");

-- CreateIndex
CREATE UNIQUE INDEX "check_in_answer_checkInId_promptCode_key" ON "check_in_answer"("checkInId", "promptCode");

-- CreateIndex
CREATE INDEX "check_in_answer_promptCode_state_idx" ON "check_in_answer"("promptCode", "state");

-- AddForeignKey
ALTER TABLE "check_in_feeling_selection" ADD CONSTRAINT "check_in_feeling_selection_checkInId_fkey" FOREIGN KEY ("checkInId") REFERENCES "emotional_check_in"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "check_in_answer" ADD CONSTRAINT "check_in_answer_checkInId_fkey" FOREIGN KEY ("checkInId") REFERENCES "emotional_check_in"("id") ON DELETE CASCADE ON UPDATE CASCADE;
