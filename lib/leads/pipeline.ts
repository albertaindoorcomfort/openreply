import { prisma } from "@/lib/db/client";
import type { StageKind } from "@/app/generated/prisma/client";

export const DEFAULT_STAGES: { key: string; name: string; kind: StageKind }[] = [
  { key: "new", name: "New inquiry", kind: "OPEN" },
  { key: "qualifying", name: "Qualifying", kind: "OPEN" },
  { key: "nurturing", name: "Nurturing", kind: "OPEN" },
  { key: "appointment", name: "Appointment", kind: "OPEN" },
  { key: "estimate", name: "Estimate", kind: "OPEN" },
  { key: "negotiation", name: "Negotiation", kind: "OPEN" },
  { key: "won", name: "Won", kind: "WON" },
  { key: "lost", name: "Lost", kind: "LOST" },
  { key: "reactivation", name: "Reactivation", kind: "OPEN" },
];

/** The workspace's default pipeline, created with the standard stages on first use. */
export async function ensureDefaultPipeline(workspaceId: string) {
  const existing = await prisma.pipeline.findFirst({
    where: { workspaceId, isDefault: true },
    include: { stages: { orderBy: { position: "asc" } } },
  });
  if (existing) return existing;
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"pipeline|" + workspaceId}, 0))`;
    const again = await tx.pipeline.findFirst({
      where: { workspaceId, isDefault: true },
      include: { stages: { orderBy: { position: "asc" } } },
    });
    if (again) return again;
    return tx.pipeline.create({
      data: {
        workspaceId,
        name: "Sales",
        isDefault: true,
        stages: { create: DEFAULT_STAGES.map((s, position) => ({ ...s, position })) },
      },
      include: { stages: { orderBy: { position: "asc" } } },
    });
  });
}
