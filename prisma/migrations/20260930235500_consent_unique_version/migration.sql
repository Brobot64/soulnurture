-- CreateIndex
CREATE UNIQUE INDEX "consent_record_studentId_version_key" ON "consent_record"("studentId", "version");
