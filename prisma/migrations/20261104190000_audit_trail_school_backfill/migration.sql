-- PE-15: GET /v1/audit is scoped to the reviewer's own school, so a row has to
-- carry that school to be readable by anyone. New writes take it from their
-- actor (AuditService.log); this applies the same rule to the rows already on
-- file, so shipping the fix does not blank a school's existing trail.
--
-- Rows with no actor (the AI worker's and the intent engine's own events) and
-- rows whose actor belongs to no school stay school-null, which now means
-- "visible to no school reviewer" rather than "visible to every one of them".

UPDATE "audit_log" a
   SET "schoolId" = u."schoolId"
  FROM "user" u
 WHERE a."actorId" = u.id
   AND a."schoolId" IS NULL
   AND u."schoolId" IS NOT NULL;
