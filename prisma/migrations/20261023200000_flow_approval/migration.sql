-- AlterTable
ALTER TABLE "Automation" ADD COLUMN "approvalId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Automation_approvalId_key" ON "Automation"("approvalId");
