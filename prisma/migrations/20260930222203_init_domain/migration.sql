-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('STUDENT', 'COUNSELLOR', 'PSYCHOLOGIST', 'SUPPORT_STAFF');

-- CreateEnum
CREATE TYPE "FeelingLabel" AS ENUM ('OVERWHELMED', 'ANXIOUS', 'TIRED', 'SAD_LOW', 'CALM', 'HOPEFUL', 'GREAT', 'HAPPY', 'PEACEFUL', 'STRESSED', 'DOWN', 'ANGRY');

-- CreateEnum
CREATE TYPE "FeelingIntensity" AS ENUM ('A_LITTLE', 'SOMEWHAT', 'A_LOT');

-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('ACTIVE', 'CLOSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('USER', 'ASSISTANT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "ResourceType" AS ENUM ('ARTICLE', 'AUDIO_GUIDE', 'SOMATIC_EXERCISE', 'INTERACTIVE', 'SOUNDSCAPE', 'AFFIRMATION', 'TOOLKIT_ITEM');

-- CreateEnum
CREATE TYPE "ResourceCategory" AS ENUM ('EXAM_STRESS', 'FRIENDSHIPS', 'FAMILY', 'IDENTITY', 'ANXIETY', 'GROUNDING', 'SLEEP', 'FOCUS', 'CULTURAL_WISDOM', 'PEER_DYNAMICS', 'GENERAL');

-- CreateEnum
CREATE TYPE "SupportPersonType" AS ENUM ('COUNSELLOR', 'PSYCHOLOGIST', 'TRUSTED_TEACHER', 'PARENT_GUARDIAN');

-- CreateEnum
CREATE TYPE "SupportTiming" AS ENUM ('GENTLE_1_2_DAYS', 'TODAY_STUDY_PERIOD', 'URGENT_UNSAFE');

-- CreateEnum
CREATE TYPE "SupportRequestStatus" AS ENUM ('PENDING', 'ACCEPTED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'ESCALATED');

-- CreateEnum
CREATE TYPE "SupportFlagSeverity" AS ENUM ('TIER_1_MODERATE', 'TIER_2_HIGH', 'TIER_3_ACUTE');

-- CreateEnum
CREATE TYPE "SupportFlagStatus" AS ENUM ('OPEN', 'IN_REVIEW', 'ACKNOWLEDGED', 'RESOLVED', 'ESCALATED');

-- CreateEnum
CREATE TYPE "SupportFlagSource" AS ENUM ('AI_CANDIDATE', 'SERVER_POLICY', 'PROFESSIONAL', 'SELF_REPORT');

-- CreateEnum
CREATE TYPE "FollowUpStatus" AS ENUM ('PENDING', 'SCHEDULED', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "user" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'STUDENT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "password" TEXT,
    "idToken" TEXT,
    "scope" TEXT,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification" (
    "id" UUID NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_profile" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT,
    "displayName" TEXT,
    "classLabel" TEXT,
    "studentRef" TEXT,
    "preferredLanguage" TEXT NOT NULL DEFAULT 'en',
    "vibe" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "student_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "professional_profile" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "title" TEXT,
    "department" TEXT,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "imageUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "professional_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_record" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "version" TEXT NOT NULL,
    "accepted" BOOLEAN NOT NULL DEFAULT false,
    "acceptedAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "consent_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "privacy_preference" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "shareAiCopingHubNotes" BOOLEAN NOT NULL DEFAULT false,
    "allowParentGuardianNotification" BOOLEAN NOT NULL DEFAULT false,
    "requestPeerSupportCompanion" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "privacy_preference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "emotional_check_in" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "feeling" "FeelingLabel" NOT NULL,
    "intensity" "FeelingIntensity" NOT NULL,
    "description" TEXT,
    "triggers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "emotional_check_in_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "checkInId" UUID,
    "source" TEXT,
    "status" "ConversationStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_message" (
    "id" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "role" "MessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "aiPayload" JSONB,
    "activeExerciseLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wellbeing_resource" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "type" "ResourceType" NOT NULL,
    "category" "ResourceCategory" NOT NULL DEFAULT 'GENERAL',
    "badge" TEXT,
    "durationMinutes" INTEGER,
    "durationLabel" TEXT,
    "ctaLabel" TEXT,
    "mediaUrl" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wellbeing_resource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "toolbox_item" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "resourceId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "toolbox_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_entry" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "title" TEXT,
    "content" TEXT NOT NULL,
    "prompt" TEXT,
    "private" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "journal_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_person" (
    "id" UUID NOT NULL,
    "professionalId" UUID,
    "name" TEXT NOT NULL,
    "type" "SupportPersonType" NOT NULL,
    "title" TEXT,
    "availabilityLabel" TEXT,
    "availableToday" BOOLEAN NOT NULL DEFAULT false,
    "imageUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_person_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_request" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "supportPersonId" UUID NOT NULL,
    "personType" "SupportPersonType" NOT NULL,
    "timing" "SupportTiming" NOT NULL,
    "note" TEXT,
    "status" "SupportRequestStatus" NOT NULL DEFAULT 'PENDING',
    "checkInId" UUID,
    "conversationId" UUID,
    "scheduledAt" TIMESTAMP(3),
    "locationLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_flag" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "conversationId" UUID,
    "assigneeId" UUID,
    "studentRef" TEXT NOT NULL,
    "classLabel" TEXT,
    "triggerLabel" TEXT NOT NULL,
    "category" TEXT,
    "severity" "SupportFlagSeverity" NOT NULL,
    "status" "SupportFlagStatus" NOT NULL DEFAULT 'OPEN',
    "source" "SupportFlagSource" NOT NULL,
    "aiContextSummary" TEXT,
    "autoActions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_flag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "follow_up" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "professionalId" UUID,
    "supportRequestId" UUID,
    "notes" TEXT,
    "status" "FollowUpStatus" NOT NULL DEFAULT 'PENDING',
    "dueAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "follow_up_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "actorId" UUID,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_phone_key" ON "user"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_key" ON "session"("token");

-- CreateIndex
CREATE UNIQUE INDEX "student_profile_userId_key" ON "student_profile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "student_profile_studentRef_key" ON "student_profile"("studentRef");

-- CreateIndex
CREATE UNIQUE INDEX "professional_profile_userId_key" ON "professional_profile"("userId");

-- CreateIndex
CREATE INDEX "consent_record_studentId_idx" ON "consent_record"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX "privacy_preference_studentId_key" ON "privacy_preference"("studentId");

-- CreateIndex
CREATE INDEX "emotional_check_in_studentId_createdAt_idx" ON "emotional_check_in"("studentId", "createdAt");

-- CreateIndex
CREATE INDEX "conversation_studentId_createdAt_idx" ON "conversation"("studentId", "createdAt");

-- CreateIndex
CREATE INDEX "conversation_message_conversationId_createdAt_idx" ON "conversation_message"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "wellbeing_resource_active_approved_category_idx" ON "wellbeing_resource"("active", "approved", "category");

-- CreateIndex
CREATE UNIQUE INDEX "toolbox_item_studentId_resourceId_key" ON "toolbox_item"("studentId", "resourceId");

-- CreateIndex
CREATE INDEX "journal_entry_studentId_createdAt_idx" ON "journal_entry"("studentId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "support_person_name_type_key" ON "support_person"("name", "type");

-- CreateIndex
CREATE INDEX "support_request_studentId_createdAt_idx" ON "support_request"("studentId", "createdAt");

-- CreateIndex
CREATE INDEX "support_flag_status_severity_createdAt_idx" ON "support_flag"("status", "severity", "createdAt");

-- CreateIndex
CREATE INDEX "follow_up_studentId_status_idx" ON "follow_up"("studentId", "status");

-- CreateIndex
CREATE INDEX "audit_log_entity_entityId_idx" ON "audit_log"("entity", "entityId");

-- CreateIndex
CREATE INDEX "audit_log_createdAt_idx" ON "audit_log"("createdAt");

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_profile" ADD CONSTRAINT "student_profile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "professional_profile" ADD CONSTRAINT "professional_profile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_record" ADD CONSTRAINT "consent_record_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "student_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "privacy_preference" ADD CONSTRAINT "privacy_preference_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "student_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emotional_check_in" ADD CONSTRAINT "emotional_check_in_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "student_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "student_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_checkInId_fkey" FOREIGN KEY ("checkInId") REFERENCES "emotional_check_in"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_message" ADD CONSTRAINT "conversation_message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "toolbox_item" ADD CONSTRAINT "toolbox_item_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "student_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "toolbox_item" ADD CONSTRAINT "toolbox_item_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "wellbeing_resource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entry" ADD CONSTRAINT "journal_entry_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "student_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_person" ADD CONSTRAINT "support_person_professionalId_fkey" FOREIGN KEY ("professionalId") REFERENCES "professional_profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_request" ADD CONSTRAINT "support_request_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "student_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_request" ADD CONSTRAINT "support_request_supportPersonId_fkey" FOREIGN KEY ("supportPersonId") REFERENCES "support_person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_request" ADD CONSTRAINT "support_request_checkInId_fkey" FOREIGN KEY ("checkInId") REFERENCES "emotional_check_in"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_request" ADD CONSTRAINT "support_request_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_flag" ADD CONSTRAINT "support_flag_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "student_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_flag" ADD CONSTRAINT "support_flag_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_flag" ADD CONSTRAINT "support_flag_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "professional_profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_up" ADD CONSTRAINT "follow_up_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "student_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_up" ADD CONSTRAINT "follow_up_professionalId_fkey" FOREIGN KEY ("professionalId") REFERENCES "professional_profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_up" ADD CONSTRAINT "follow_up_supportRequestId_fkey" FOREIGN KEY ("supportRequestId") REFERENCES "support_request"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
