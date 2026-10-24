DROP INDEX "support_person_name_type_key";

CREATE INDEX "support_person_professionalId_type_idx" ON "support_person"("professionalId", "type");

-- Only an existing professional/account relationship establishes school ownership; names never do.
INSERT INTO "support_person" (
  "id", "professionalId", "name", "type", "title", "imageUrl", "updatedAt"
)
SELECT
  gen_random_uuid(), p."id", u."name", u."role"::text::"SupportPersonType",
  p."title", p."imageUrl", CURRENT_TIMESTAMP
FROM "professional_profile" p
JOIN "user" u ON u."id" = p."userId"
WHERE u."schoolId" IS NOT NULL
  AND u."role" IN ('COUNSELLOR', 'PSYCHOLOGIST', 'SUPPORT_STAFF')
  AND NOT EXISTS (
    SELECT 1 FROM "support_person" person WHERE person."professionalId" = p."id"
  );
