-- CreateEnum
CREATE TYPE "AiJobStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED');

-- AlterTable
ALTER TABLE "support_flag" ADD COLUMN     "intentId" TEXT;

-- CreateTable
CREATE TABLE "ai_generation_job" (
    "id" UUID NOT NULL,
    "conversationMessageId" UUID NOT NULL,
    "input" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextRetryAt" TIMESTAMP(3),
    "status" "AiJobStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_generation_job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_generation_job_conversationMessageId_key" ON "ai_generation_job"("conversationMessageId");

-- CreateIndex
CREATE INDEX "ai_generation_job_status_nextRetryAt_idx" ON "ai_generation_job"("status", "nextRetryAt");

-- AddForeignKey
ALTER TABLE "ai_generation_job" ADD CONSTRAINT "ai_generation_job_conversationMessageId_fkey" FOREIGN KEY ("conversationMessageId") REFERENCES "conversation_message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
