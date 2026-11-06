-- Doc B §3 replaces the student-facing resource taxonomy with eight approved
-- labels. The twelve WN-* resources can only be published under those labels,
-- because a card heading has to match the approved wording exactly.
--
-- The eleven values already on this type are not touched: `WellbeingActivity`
-- and the AI activity catalogue key off GROUNDING/SLEEP/ANXIETY/GENERAL, and an
-- enum value cannot be dropped while any row still uses it. The withdrawn
-- placeholder rows keep their old category and stay invisible for the reason
-- they were withdrawn — not because the value disappeared.
--
-- Additive, and safe to re-run: IF NOT EXISTS makes a repeat a no-op.
ALTER TYPE "ResourceCategory" ADD VALUE IF NOT EXISTS 'FEELINGS';
ALTER TYPE "ResourceCategory" ADD VALUE IF NOT EXISTS 'STEADIER';
ALTER TYPE "ResourceCategory" ADD VALUE IF NOT EXISTS 'ONE_STEP';
ALTER TYPE "ResourceCategory" ADD VALUE IF NOT EXISTS 'KINDNESS';
ALTER TYPE "ResourceCategory" ADD VALUE IF NOT EXISTS 'DIFFICULT_MOMENT';
ALTER TYPE "ResourceCategory" ADD VALUE IF NOT EXISTS 'HEAVY';
ALTER TYPE "ResourceCategory" ADD VALUE IF NOT EXISTS 'ASK_FOR_SUPPORT';
ALTER TYPE "ResourceCategory" ADD VALUE IF NOT EXISTS 'REST';
