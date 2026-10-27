import { prisma } from "@/lib/db/client";
import type { Actor } from "./timeline";

/** The day at a glance for one person: what needs a reply, what is due, what is new. */
export async function getToday(actor: Actor & { id: string }, now = new Date()) {
  const ws = actor.workspaceId;
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);
  const since = new Date(now.getTime() - 24 * 3600_000);
  const [awaitingReply, draftsToReview, myTasks, overdue, newLeads, handoffs, stageCounts] = await Promise.all([
    prisma.conversation.count({ where: { workspaceId: ws, status: "OPEN", unreadCount: { gt: 0 } } }),
    prisma.draft.count({ where: { workspaceId: ws, status: "PROPOSED" } }),
    prisma.task.findMany({
      where: { workspaceId: ws, status: "OPEN", deletedAt: null, OR: [{ assigneeUserId: actor.id }, { assigneeUserId: null }], dueAt: { lte: endOfDay } },
      orderBy: [{ dueAt: "asc" }],
      take: 50,
      include: { contact: { select: { id: true, displayName: true } } },
    }),
    prisma.task.count({ where: { workspaceId: ws, status: "OPEN", deletedAt: null, dueAt: { lt: now } } }),
    prisma.contact.findMany({
      where: { workspaceId: ws, createdAt: { gte: since }, mergedIntoId: null, deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, displayName: true, source: true, leadScore: true, stageKey: true, createdAt: true },
    }),
    prisma.conversation.findMany({
      where: { workspaceId: ws, status: "OPEN", mode: "HUMAN", OR: [{ ownerUserId: actor.id }, { ownerUserId: null }] },
      orderBy: { updatedAt: "desc" },
      take: 20,
      include: { contact: { select: { id: true, displayName: true } } },
    }),
    prisma.opportunity.groupBy({ by: ["stageKey"], where: { workspaceId: ws, deletedAt: null }, _count: { _all: true }, _sum: { valueCents: true } }),
  ]);
  const firstResponse = await medianFirstResponseMinutes(ws, new Date(now.getTime() - 30 * 24 * 3600_000));
  return {
    counts: { awaitingReply, draftsToReview, overdue },
    myTasks,
    newLeads,
    handoffs,
    pipeline: stageCounts.map((s) => ({ stageKey: s.stageKey, count: s._count._all, valueCents: s._sum.valueCents ?? 0 })),
    metrics: { medianFirstResponseMinutes30d: firstResponse },
  };
}

/** Median minutes from a conversation's first inbound message to its first outbound reply. */
export async function medianFirstResponseMinutes(workspaceId: string, since: Date): Promise<number | null> {
  const rows = await prisma.$queryRaw<{ minutes: number | null }[]>`
    WITH firsts AS (
      SELECT m."conversationId",
        MIN(m."occurredAt") FILTER (WHERE m.direction = 'INBOUND') AS first_in,
        MIN(m."occurredAt") FILTER (WHERE m.direction = 'OUTBOUND') AS first_out
      FROM "Message" m
      JOIN "Conversation" c ON c.id = m."conversationId"
      WHERE c."workspaceId" = ${workspaceId} AND c."createdAt" >= ${since}
      GROUP BY m."conversationId"
    )
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (first_out - first_in)) / 60)::float AS minutes
    FROM firsts WHERE first_in IS NOT NULL AND first_out IS NOT NULL AND first_out >= first_in`;
  const v = rows[0]?.minutes;
  return v == null ? null : Math.round(v * 10) / 10;
}
