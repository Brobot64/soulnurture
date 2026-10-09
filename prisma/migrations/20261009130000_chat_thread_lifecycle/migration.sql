-- AlterTable: lifecycle stamps for the admin chat-thread register
ALTER TABLE "chat_thread" ADD COLUMN "claimedAt" TIMESTAMP(3);
ALTER TABLE "chat_thread" ADD COLUMN "closedAt" TIMESTAMP(3);
