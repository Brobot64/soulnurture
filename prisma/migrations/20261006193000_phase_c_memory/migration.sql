-- Phase C step 3: session summaries + pgvector memory.
-- Requires the pgvector extension (prod image: pgvector/pgvector:pg17).

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TYPE "AiJobKind" AS ENUM ('REPLY', 'SUMMARY', 'VERNACULAR');

ALTER TABLE "ai_generation_job"
  ADD COLUMN "kind" "AiJobKind" NOT NULL DEFAULT 'REPLY',
  ALTER COLUMN "conversationMessageId" DROP NOT NULL;

CREATE INDEX "ai_generation_job_kind_status_idx" ON "ai_generation_job"("kind", "status");

CREATE TABLE "session_summary" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "summary" VARCHAR(400) NOT NULL,
    "topics" TEXT[] NOT NULL,
    "followUpHook" VARCHAR(140),
    "emotionalTrend" TEXT,
    "summaryLocalized" TEXT,
    "followUpHookLocalized" TEXT,
    "embedding" vector(1536),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_summary_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "session_summary_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "student_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "session_summary_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "session_summary_conversationId_key" ON "session_summary"("conversationId");
CREATE INDEX "session_summary_studentId_createdAt_idx" ON "session_summary"("studentId", "createdAt");
