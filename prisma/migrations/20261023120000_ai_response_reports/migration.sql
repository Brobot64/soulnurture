CREATE TABLE "ai_response_report" (
    "id" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "responseContent" TEXT NOT NULL,
    "responseLanguage" TEXT,
    "note" VARCHAR(2000),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ai_response_report_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ai_response_report_messageId_key" ON "ai_response_report"("messageId");
CREATE INDEX "ai_response_report_createdAt_id_idx" ON "ai_response_report"("createdAt", "id");
ALTER TABLE "ai_response_report" ADD CONSTRAINT "ai_response_report_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "conversation_message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
