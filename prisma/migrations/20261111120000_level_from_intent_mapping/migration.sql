-- Doc A §3 levels for the indicators that were already in the table.
--
-- This is the same table as `src/ai/intents/indicator-levels.ts`, spelled out in
-- SQL because a migration cannot import from `src`. The two move together: a row
-- changed here without changing the mapping would make an old flag and a new one
-- grade differently off the same condition, which is exactly what the staff
-- level chips would then be counting.
--
-- Nothing is invented. Every flag below already fired its trigger and already
-- alerted; this records which §3 condition that was. `level IS NULL` keeps the
-- statements idempotent and leaves any level a reviewer set by hand alone, and
-- "updatedAt" is deliberately untouched — a backfill is not an edit, and the
-- audit trail is where the difference belongs.
--
-- Order matters and mirrors `levelForVerdict`: the condition statements run
-- first, so the tier statements below only ever touch rows no condition graded.

UPDATE "support_flag" SET "level" = 'C'::"IndicatorLevel"
 WHERE "level" IS NULL
   AND "intentId" IN ('SUICIDAL_IDEATION', 'SELF_HARM', 'ABUSE_DISCLOSURE', 'THREAT_OR_COERCION');

UPDATE "support_flag" SET "level" = 'B'::"IndicatorLevel"
 WHERE "level" IS NULL
   AND "intentId" IN ('PROLONGED_LOW_MOOD', 'ACUTE_PANIC');

-- The tier fallback (Product Owner, 2026-11-12): the level is read off the
-- severity the AI itself asserted. In practice every row reached here is an
-- unbound model candidate — `intentId IS NULL` and `source = 'AI_CANDIDATE'`,
-- the only flag the engine raises without a condition — which v1 of the mapping
-- graded U. It is now graded by its tier, so the uncertainty travels as
-- `levelSource = 'AI_TIER'` and `Raised by: Ai Candidate` instead of as a level.
-- The tier is non-nullable, so these three statements leave nothing Unclassified.
UPDATE "support_flag" SET "level" = 'A'::"IndicatorLevel"
 WHERE "level" IS NULL
   AND "severity" = 'TIER_1_MODERATE';

UPDATE "support_flag" SET "level" = 'B'::"IndicatorLevel"
 WHERE "level" IS NULL
   AND "severity" = 'TIER_2_HIGH';

UPDATE "support_flag" SET "level" = 'C'::"IndicatorLevel"
 WHERE "level" IS NULL
   AND "severity" = 'TIER_3_ACUTE';
