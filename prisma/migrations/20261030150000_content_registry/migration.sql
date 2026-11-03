-- Content registry (Doc C §6/§7) + audit provenance columns (US-D03/D10).
-- Entirely additive: new enums, new table, four nullable columns on audit_log.
-- No existing column, index or row is altered or dropped.

-- CreateEnum
CREATE TYPE "ContentKind" AS ENUM ('EMOTION_TERM', 'CHECKIN_PROMPT', 'RESPONSE_OPTION', 'WELLBEING_RESOURCE', 'WELLBEING_ACTIVITY', 'SAFEGUARDING_PROMPT', 'AGE_BAND_RULE', 'CATEGORY');

-- CreateEnum
CREATE TYPE "ContentStatus" AS ENUM ('DRAFT', 'CONTENT_REVIEW_REQUIRED', 'APPROVED_ACTIVE', 'BLOCKED', 'SUPERSEDED', 'RETIRED');

-- CreateEnum
CREATE TYPE "ApprovalNamespace" AS ENUM ('EDUCATION', 'WELLBEING', 'SAFEGUARDING');

-- CreateTable
CREATE TABLE "content_item" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "kind" "ContentKind" NOT NULL,
    "namespace" "ApprovalNamespace" NOT NULL,
    "status" "ContentStatus" NOT NULL DEFAULT 'DRAFT',
    "majorVersion" INTEGER NOT NULL DEFAULT 1,
    "minorVersion" INTEGER NOT NULL DEFAULT 0,
    "patchVersion" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB NOT NULL,
    "ageBand" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "effectiveFrom" TIMESTAMP(3),
    "effectiveTo" TIMESTAMP(3),
    "supersedesId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_item_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "content_item_code_versions_locale_key" ON "content_item"("code", "majorVersion", "minorVersion", "patchVersion", "locale");

-- CreateIndex
CREATE INDEX "content_item_kind_status_locale_ageBand_idx" ON "content_item"("kind", "status", "locale", "ageBand");

-- AlterTable
ALTER TABLE "audit_log" ADD COLUMN "priorStatus" TEXT, ADD COLUMN "newStatus" TEXT, ADD COLUMN "ruleId" TEXT, ADD COLUMN "ruleVersion" TEXT;
