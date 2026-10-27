-- Intent gate: a campaign may require that a comment means what it offers,
-- not just that it contains a keyword. All four columns are additive with
-- defaults, so existing rows keep today's behaviour and no backfill runs.
--
-- Prisma applies a migration one statement at a time, not in a transaction,
-- so every ADD COLUMN here uses IF NOT EXISTS: if one statement fails, the
-- recovery path (`prisma migrate resolve --rolled-back` then redeploy)
-- re-runs this file from the top, and the columns already added must not
-- error a second time.

-- AlterTable
ALTER TABLE "Automation" ADD COLUMN IF NOT EXISTS "intentGateEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Automation" ADD COLUMN IF NOT EXISTS "intentDescription" TEXT;
ALTER TABLE "Automation" ADD COLUMN IF NOT EXISTS "intentThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.7;

-- AlterTable
ALTER TABLE "DmLog" ADD COLUMN IF NOT EXISTS "intentProbability" DOUBLE PRECISION;
