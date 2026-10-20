
-- CreateEnum
CREATE TYPE "MicrosoftConnectionStatus" AS ENUM ('ACTIVE', 'NEEDS_REAUTH', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "GraphSubscriptionStatus" AS ENUM ('ACTIVE', 'RENEW_FAILED', 'REMOVED');

-- CreateEnum
CREATE TYPE "GraphNotificationStatus" AS ENUM ('PENDING', 'PROCESSED', 'FAILED', 'DEAD');

-- CreateEnum
CREATE TYPE "MeetingStatus" AS ENUM ('SCHEDULED', 'CANCELLED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "MeetingSource" AS ENUM ('OUTLOOK', 'AIC');

-- CreateEnum
CREATE TYPE "MeetingNoteKind" AS ENUM ('MANUAL', 'TRANSCRIPT');

-- CreateEnum
CREATE TYPE "MeetingConsentKind" AS ENUM ('RECORDING', 'TRANSCRIPTION');

-- CreateEnum
CREATE TYPE "MeetingConsentStatus" AS ENUM ('GRANTED', 'DECLINED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "MeetingFollowUpStatus" AS ENUM ('PROPOSED', 'RELAY_DRAFT', 'OUTLOOK_DRAFT', 'DISCARDED');

-- CreateTable
CREATE TABLE "MicrosoftConnection" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "msTenantId" TEXT NOT NULL,
    "msUserId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT,
    "grantedScopes" TEXT[],
    "accessTokenEnc" TEXT NOT NULL,
    "accessExpiresAt" TIMESTAMP(3) NOT NULL,
    "refreshTokenEnc" TEXT NOT NULL,
    "status" "MicrosoftConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "statusReason" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'America/Edmonton',
    "calendarDeltaLink" TEXT,
    "calendarSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MicrosoftConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GraphSubscription" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "graphSubscriptionId" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "changeType" TEXT NOT NULL,
    "clientStateHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" "GraphSubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lastRenewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GraphSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GraphNotification" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "graphSubscriptionId" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "changeType" TEXT NOT NULL,
    "resourceId" TEXT,
    "lifecycleEvent" TEXT,
    "status" "GraphNotificationStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "GraphNotification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Meeting" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "graphEventId" TEXT,
    "iCalUId" TEXT,
    "changeKey" TEXT,
    "title" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "timezone" TEXT NOT NULL,
    "location" TEXT,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "joinUrl" TEXT,
    "onlineMeetingId" TEXT,
    "organizerEmail" TEXT,
    "attendees" JSONB NOT NULL DEFAULT '[]',
    "status" "MeetingStatus" NOT NULL DEFAULT 'SCHEDULED',
    "source" "MeetingSource" NOT NULL DEFAULT 'OUTLOOK',
    "showAs" TEXT,
    "contactId" TEXT,
    "opportunityId" TEXT,
    "conversationId" TEXT,
    "campaignRef" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Meeting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeetingNote" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "kind" "MeetingNoteKind" NOT NULL,
    "body" TEXT NOT NULL,
    "authorKind" TEXT NOT NULL,
    "authorId" TEXT,
    "externalRef" TEXT,
    "segments" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deletedAt" TIMESTAMP(3),
    "purgeAfter" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MeetingNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeetingConsent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "kind" "MeetingConsentKind" NOT NULL,
    "status" "MeetingConsentStatus" NOT NULL,
    "method" TEXT NOT NULL,
    "disclosureText" TEXT NOT NULL,
    "participants" TEXT[],
    "capturedByUserId" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MeetingConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeetingBrief" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "producer" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MeetingBrief_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeetingSummary" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "decisions" JSONB NOT NULL DEFAULT '[]',
    "actionItems" JSONB NOT NULL DEFAULT '[]',
    "producer" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "authorKind" TEXT NOT NULL,
    "authorId" TEXT,
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MeetingSummary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeetingFollowUp" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "to" TEXT[],
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "MeetingFollowUpStatus" NOT NULL DEFAULT 'PROPOSED',
    "relayDraftId" TEXT,
    "outlookDraftId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdByKind" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MeetingFollowUp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeetingEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "actorKind" TEXT NOT NULL,
    "actorId" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "relayType" TEXT,
    "relayPushedAt" TIMESTAMP(3),
    "relayAttempts" INTEGER NOT NULL DEFAULT 0,
    "relayError" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MeetingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeetingSettings" (
    "workspaceId" TEXT NOT NULL,
    "transcriptRetentionDays" INTEGER NOT NULL DEFAULT 365,
    "recordingDisclosure" TEXT NOT NULL DEFAULT 'This meeting may be transcribed so we can keep accurate notes. Let us know if you would prefer it is not.',
    "businessHoursStart" INTEGER NOT NULL DEFAULT 8,
    "businessHoursEnd" INTEGER NOT NULL DEFAULT 17,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MeetingSettings_pkey" PRIMARY KEY ("workspaceId")
);

-- CreateIndex
CREATE INDEX "MicrosoftConnection_status_idx" ON "MicrosoftConnection"("status");

-- CreateIndex
CREATE UNIQUE INDEX "MicrosoftConnection_workspaceId_userId_key" ON "MicrosoftConnection"("workspaceId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "MicrosoftConnection_workspaceId_msTenantId_msUserId_key" ON "MicrosoftConnection"("workspaceId", "msTenantId", "msUserId");

-- CreateIndex
CREATE UNIQUE INDEX "GraphSubscription_graphSubscriptionId_key" ON "GraphSubscription"("graphSubscriptionId");

-- CreateIndex
CREATE INDEX "GraphSubscription_workspaceId_idx" ON "GraphSubscription"("workspaceId");

-- CreateIndex
CREATE INDEX "GraphSubscription_status_expiresAt_idx" ON "GraphSubscription"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "GraphNotification_dedupeKey_key" ON "GraphNotification"("dedupeKey");

-- CreateIndex
CREATE INDEX "GraphNotification_status_nextAttemptAt_idx" ON "GraphNotification"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "GraphNotification_workspaceId_idx" ON "GraphNotification"("workspaceId");

-- CreateIndex
CREATE INDEX "Meeting_workspaceId_startsAt_idx" ON "Meeting"("workspaceId", "startsAt");

-- CreateIndex
CREATE INDEX "Meeting_workspaceId_contactId_idx" ON "Meeting"("workspaceId", "contactId");

-- CreateIndex
CREATE INDEX "Meeting_workspaceId_opportunityId_idx" ON "Meeting"("workspaceId", "opportunityId");

-- CreateIndex
CREATE UNIQUE INDEX "Meeting_connectionId_graphEventId_key" ON "Meeting"("connectionId", "graphEventId");

-- CreateIndex
CREATE INDEX "MeetingNote_workspaceId_idx" ON "MeetingNote"("workspaceId");

-- CreateIndex
CREATE INDEX "MeetingNote_purgeAfter_idx" ON "MeetingNote"("purgeAfter");

-- CreateIndex
CREATE UNIQUE INDEX "MeetingNote_meetingId_externalRef_key" ON "MeetingNote"("meetingId", "externalRef");

-- CreateIndex
CREATE INDEX "MeetingConsent_meetingId_kind_capturedAt_idx" ON "MeetingConsent"("meetingId", "kind", "capturedAt");

-- CreateIndex
CREATE INDEX "MeetingBrief_meetingId_createdAt_idx" ON "MeetingBrief"("meetingId", "createdAt");

-- CreateIndex
CREATE INDEX "MeetingSummary_meetingId_createdAt_idx" ON "MeetingSummary"("meetingId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MeetingFollowUp_idempotencyKey_key" ON "MeetingFollowUp"("idempotencyKey");

-- CreateIndex
CREATE INDEX "MeetingFollowUp_meetingId_idx" ON "MeetingFollowUp"("meetingId");

-- CreateIndex
CREATE INDEX "MeetingEvent_meetingId_occurredAt_idx" ON "MeetingEvent"("meetingId", "occurredAt");

-- CreateIndex
CREATE INDEX "MeetingEvent_relayType_relayPushedAt_idx" ON "MeetingEvent"("relayType", "relayPushedAt");

-- AddForeignKey
ALTER TABLE "GraphSubscription" ADD CONSTRAINT "GraphSubscription_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "MicrosoftConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "MicrosoftConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingNote" ADD CONSTRAINT "MeetingNote_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingConsent" ADD CONSTRAINT "MeetingConsent_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingBrief" ADD CONSTRAINT "MeetingBrief_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingSummary" ADD CONSTRAINT "MeetingSummary_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingFollowUp" ADD CONSTRAINT "MeetingFollowUp_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MeetingEvent" ADD CONSTRAINT "MeetingEvent_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

