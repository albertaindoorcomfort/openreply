-- CreateEnum
CREATE TYPE "InboundMailStatus" AS ENUM ('PENDING', 'DELIVERED', 'SKIPPED', 'FAILED', 'DEAD');

-- AlterTable
ALTER TABLE "MicrosoftConnection" ADD COLUMN     "mailDeltaLink" TEXT,
ADD COLUMN     "mailIngestFrom" TIMESTAMP(3),
ADD COLUMN     "mailSyncedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "InboundMail" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "graphMessageId" TEXT NOT NULL,
    "internetMessageId" TEXT,
    "receivedAt" TIMESTAMP(3),
    "status" "InboundMailStatus" NOT NULL DEFAULT 'PENDING',
    "skipReason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "relayConversationId" TEXT,
    "relayMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InboundMail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InboundMail_status_nextAttemptAt_idx" ON "InboundMail"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "InboundMail_workspaceId_idx" ON "InboundMail"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "InboundMail_connectionId_graphMessageId_key" ON "InboundMail"("connectionId", "graphMessageId");

-- AddForeignKey
ALTER TABLE "InboundMail" ADD CONSTRAINT "InboundMail_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "MicrosoftConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

