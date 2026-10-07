-- CreateTable
CREATE TABLE "wellbeing_activity" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" "ResourceCategory" NOT NULL DEFAULT 'GENERAL',
    "steps" JSONB NOT NULL,
    "durationSeconds" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wellbeing_activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_session" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "activityId" UUID NOT NULL,
    "conversationId" UUID,
    "intentId" TEXT,
    "recommendedBy" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "feelingAfter" "FeelingLabel",
    "noteAfter" VARCHAR(500),

    CONSTRAINT "activity_session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wellbeing_activity_slug_key" ON "wellbeing_activity"("slug");

-- CreateIndex
CREATE INDEX "wellbeing_activity_active_approved_category_idx" ON "wellbeing_activity"("active", "approved", "category");

-- CreateIndex
CREATE INDEX "activity_session_studentId_startedAt_idx" ON "activity_session"("studentId", "startedAt");

-- AddForeignKey
ALTER TABLE "activity_session" ADD CONSTRAINT "activity_session_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "student_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_session" ADD CONSTRAINT "activity_session_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "wellbeing_activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_session" ADD CONSTRAINT "activity_session_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
