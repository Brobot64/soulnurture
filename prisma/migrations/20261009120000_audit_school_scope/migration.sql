-- AlterTable
ALTER TABLE "audit_log" ADD COLUMN     "schoolId" UUID;

-- CreateIndex
CREATE INDEX "audit_log_schoolId_idx" ON "audit_log"("schoolId");

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "school"("id") ON DELETE SET NULL ON UPDATE CASCADE;
