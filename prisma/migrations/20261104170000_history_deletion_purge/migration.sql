-- Epic H, the owner's 2026-11-04 ruling: a student's deletion ask is a
-- SCHEDULED erasure with a 24-hour undo window, not a review queue. Entirely
-- additive — four nullable/ defaulted columns on the request table, no existing
-- row or column touched, so every current read and safeguarding path behaves
-- exactly as it does today until a worker is pointed at these columns.
--
-- TIMESTAMPTZ, not the timestamp(3) the older columns use: due-ness is compared
-- against Postgres NOW() in the worker (the ai_generation_job precedent), and a
-- naive timestamp column across client/DB clocks is how timezone drift gets
-- baked into an irreversible job.
--
-- "scheduledPurgeAt" is the moment the erasure runs. NULL means "this ask was
-- created before the engine existed" — the worker ignores those rows rather than
-- honouring an ask nobody scheduled.
-- "cancelledAt"  is set only inside the window; a cancelled ask is never purged.
-- "purgedAt"     is set only for the partial scopes, because an ALL_HISTORY
--                purge deletes the student row and this row cascades with it —
--                the audit row "history_deletion.executed" is that erasure's
--                only surviving record.
-- "holdReason"   is why a due purge did NOT run (the account cannot sign in, so
--                the 24 hours would be a lie) and is shown on the receipt.

-- AlterTable
ALTER TABLE "history_deletion_request" ADD COLUMN "scheduledPurgeAt" TIMESTAMPTZ,
ADD COLUMN "cancelledAt" TIMESTAMPTZ,
ADD COLUMN "purgedAt" TIMESTAMPTZ,
ADD COLUMN "holdReason" TEXT,
ADD COLUMN "removedCheckIns" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "removedConversations" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
-- The worker's due-scan. Partial, because the live set is rows still owed work;
-- a full index on a table whose history only grows would be scanned in full.
CREATE INDEX "history_deletion_request_due_idx" ON "history_deletion_request"("scheduledPurgeAt") WHERE "purgedAt" IS NULL AND "cancelledAt" IS NULL;
