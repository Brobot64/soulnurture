-- Doc A indicator surfaces (G1 level axis, G3 rule provenance, G4 decision apart
-- from status, US-D02 statement freeze). Entirely additive: two new enums and
-- five nullable columns on support_flag. Every existing flag keeps its current status,
-- severity and alert behaviour; an unclassified level reads as null, never as A.

-- CreateEnum
CREATE TYPE "IndicatorLevel" AS ENUM ('A', 'B', 'C', 'U');

-- CreateEnum
CREATE TYPE "SupportFlagReviewDecision" AS ENUM ('NO_FURTHER_ACTION', 'FOLLOW_UP_WITH_STUDENT', 'FOLLOW_SAFEGUARDING_PROCEDURE');

-- AlterTable
ALTER TABLE "support_flag" ADD COLUMN "level" "IndicatorLevel", ADD COLUMN "ruleId" TEXT, ADD COLUMN "ruleVersion" TEXT, ADD COLUMN "reviewDecision" "SupportFlagReviewDecision", ADD COLUMN "studentStatementSnapshot" TEXT;
