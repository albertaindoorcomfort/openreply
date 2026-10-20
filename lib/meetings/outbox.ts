import { prisma } from "@/lib/db/client";
import type { FeedbackInput, RelayApi, TimelineInput } from "./relay-client";

const MAX_ATTEMPTS = 10;

/**
 * Pushes queued meeting.* events to the Relay timeline, and summary
 * corrections to Relay's feedback queue. A timeline event waits until
 * its meeting is linked to a contact or opportunity. The event id is the
 * idempotency key, which Relay dedupes per workspace, so a retry after a lost
 * response cannot write the entry twice.
 */
export async function pushTimelineOutbox(relay: RelayApi, limit = 100) {
  const rows = await prisma.meetingEvent.findMany({
    where: {
      relayPushedAt: null,
      relayAttempts: { lt: MAX_ATTEMPTS },
      OR: [
        // Corrections go to POST /feedback whether or not the meeting is linked.
        { relayType: "feedback" },
        {
          relayType: { not: null },
          meeting: { OR: [{ contactId: { not: null } }, { opportunityId: { not: null } }] },
        },
      ],
    },
    include: { meeting: true },
    orderBy: { occurredAt: "asc" },
    take: limit,
  });
  const stats = { pushed: 0, failed: 0 };
  for (const row of rows) {
    const m = row.meeting;
    try {
      if (row.relayType === "feedback") {
        const p = row.payload as { targetId: string; original: unknown; corrected: unknown; reason: string | null };
        const feedback: FeedbackInput = {
          targetKind: "MEETING_NOTE",
          targetId: p.targetId,
          original: p.original,
          corrected: p.corrected,
          reason: p.reason,
          contactId: m.contactId,
          correctedBy: row.actorId ?? "",
          idempotencyKey: row.id,
        };
        await relay.postFeedback(feedback);
        await prisma.meetingEvent.update({ where: { id: row.id }, data: { relayPushedAt: new Date(), relayError: null } });
        stats.pushed++;
        continue;
      }
      await relay.postTimeline({
        type: row.relayType as TimelineInput["type"],
        idempotencyKey: row.id,
        contactId: m.contactId,
        opportunityId: m.opportunityId,
        occurredAt: row.occurredAt.toISOString(),
        payload: {
          meetingRef: `aic:meeting:${m.id}`,
          title: m.title,
          startsAt: m.startsAt.toISOString(),
          endsAt: m.endsAt.toISOString(),
          status: m.status,
          outlookEventId: m.graphEventId,
          iCalUId: m.iCalUId,
          actor: { kind: row.actorKind, id: row.actorId },
          ...(row.payload as Record<string, unknown>),
        },
      });
      await prisma.meetingEvent.update({ where: { id: row.id }, data: { relayPushedAt: new Date(), relayError: null } });
      stats.pushed++;
    } catch (error) {
      await prisma.meetingEvent.update({
        where: { id: row.id },
        data: { relayAttempts: { increment: 1 }, relayError: error instanceof Error ? error.message.slice(0, 200) : "error" },
      });
      stats.failed++;
    }
  }
  return stats;
}

/** Deletes transcript notes past the workspace's retention period. Typed notes are kept. */
export async function purgeExpiredTranscripts(now = new Date()) {
  const r = await prisma.meetingNote.deleteMany({ where: { kind: "TRANSCRIPT", purgeAfter: { lt: now } } });
  return r.count;
}
