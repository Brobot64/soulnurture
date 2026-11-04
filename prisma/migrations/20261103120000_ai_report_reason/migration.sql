-- Epic G "Did something feel off?" — the student's reason for flagging an AI
-- reply, so reviewers get a countable signal instead of prose alone. Additive:
-- the column is nullable, so reports filed before this change stay exactly as
-- they were and read as "no reason given". The submit path requires a reason
-- from now on; "OTHER" is the catch-all, so no student is blocked from
-- reporting by the fixed set.

-- CreateEnum
CREATE TYPE "AiReportReason" AS ENUM ('DIAGNOSIS_OR_MEDICAL_ADVICE', 'UNSAFE_OR_UNKIND', 'DID_NOT_UNDERSTAND', 'OTHER');

-- AlterTable
ALTER TABLE "ai_response_report" ADD COLUMN "reason" "AiReportReason";
