import type { MicrosoftConnection, Meeting, Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { GraphClient, GraphError, parseGraphDate, type GraphEvent } from "@/lib/microsoft/graph";
import { internalDomains, isInternal, recordMeetingEvent, SYSTEM, type Attendee } from "./events";
import type { RelayApi } from "./relay-client";

/** Sync window: recent history for follow-ups, and the quarter ahead. */
const PAST_DAYS = 30;
const FUTURE_DAYS = 90;

export type ApplyResult = "created" | "updated" | "rescheduled" | "cancelled" | "unchanged" | "ignored";

function toAttendees(ev: GraphEvent, domains: string[]): Attendee[] {
  return (ev.attendees ?? [])
    .filter((a) => a.type !== "resource" && a.emailAddress?.address)
    .map((a) => {
      const email = a.emailAddress.address.toLowerCase();
      return {
        email,
        name: a.emailAddress.name ?? null,
        type: a.type ?? "required",
        response: a.status?.response ?? null,
        internal: isInternal(email, domains),
      };
    });
}

/**
 * Upserts one Outlook event into its Meeting. Idempotent: the same changeKey
 * twice is a no-op, so duplicate notifications and delta pages are harmless.
 * Outlook is the source of truth for time, title and attendees; AIC owns the
 * lead links, notes and summaries, which a sync never touches.
 */
export async function applyGraphEvent(
  connection: Pick<MicrosoftConnection, "id" | "workspaceId" | "email" | "timezone">,
  ev: GraphEvent,
  relay: RelayApi | null
): Promise<ApplyResult> {
  const existing = await prisma.meeting.findUnique({
    where: { connectionId_graphEventId: { connectionId: connection.id, graphEventId: ev.id } },
  });

  if (ev["@removed"] || ev.isCancelled) {
    if (!existing || existing.status === "CANCELLED") return existing ? "unchanged" : "ignored";
    await prisma.$transaction(async (tx) => {
      await tx.meeting.update({ where: { id: existing.id }, data: { status: "CANCELLED", version: { increment: 1 }, lastSyncedAt: new Date() } });
      await recordMeetingEvent(tx, existing, "meeting.cancelled", SYSTEM, { source: "outlook" });
    });
    return "cancelled";
  }

  const startsAt = parseGraphDate(ev.start);
  const endsAt = parseGraphDate(ev.end);
  if (!startsAt || !endsAt) return "ignored";
  // Free-time blocks and series masters are not meetings; occurrences are.
  if (ev.type === "seriesMaster" || (!ev.attendees?.length && ev.showAs === "free")) return "ignored";

  if (existing && ev.changeKey && existing.changeKey === ev.changeKey) return "unchanged";

  const domains = internalDomains(connection.email);
  const attendees = toAttendees(ev, domains);
  const fields = {
    iCalUId: ev.iCalUId ?? null,
    changeKey: ev.changeKey ?? null,
    title: ev.subject?.trim() || "(no title)",
    startsAt,
    endsAt,
    location: ev.location?.displayName || null,
    isOnline: !!ev.isOnlineMeeting,
    joinUrl: ev.onlineMeeting?.joinUrl ?? null,
    organizerEmail: ev.organizer?.emailAddress.address.toLowerCase() ?? null,
    attendees: attendees as unknown as Prisma.InputJsonValue,
    showAs: ev.showAs ?? null,
    lastSyncedAt: new Date(),
  };

  if (!existing) {
    // A booking made from AIC is already stored under its transactionId; claim it.
    const pending = ev.transactionId
      ? await prisma.meeting.findFirst({ where: { connectionId: connection.id, graphEventId: null, id: ev.transactionId } })
      : null;
    const link = pending ? {} : await autoLink(attendees, relay);
    await prisma.$transaction(async (tx) => {
      const m = pending
        ? await tx.meeting.update({ where: { id: pending.id }, data: { ...fields, graphEventId: ev.id, status: "SCHEDULED", deletedAt: null, version: { increment: 1 } } })
        : await tx.meeting.create({
            data: { ...fields, ...link, workspaceId: connection.workspaceId, connectionId: connection.id, graphEventId: ev.id, timezone: connection.timezone, source: "OUTLOOK" },
          });
      await recordMeetingEvent(tx, m, pending ? "meeting.scheduled" : "meeting.synced", SYSTEM, { source: "outlook" }, "meeting.scheduled");
      return m;
    });
    return "created";
  }

  const moved = existing.startsAt.getTime() !== startsAt.getTime() || existing.endsAt.getTime() !== endsAt.getTime();
  await prisma.$transaction(async (tx) => {
    await tx.meeting.update({
      where: { id: existing.id },
      data: { ...fields, status: existing.status === "CANCELLED" ? "SCHEDULED" : existing.status, version: { increment: 1 } },
    });
    if (moved) {
      await recordMeetingEvent(
        tx,
        existing,
        "meeting.rescheduled",
        SYSTEM,
        { source: "outlook", from: existing.startsAt.toISOString(), to: startsAt.toISOString() },
        "meeting.rescheduled"
      );
    }
  });
  return moved ? "rescheduled" : "updated";
}

/** Links a new meeting to a lead when exactly one external attendee matches exactly one contact. */
async function autoLink(attendees: Attendee[], relay: RelayApi | null): Promise<Partial<Pick<Meeting, "contactId">>> {
  if (!relay) return {};
  const external = attendees.filter((a) => !a.internal);
  if (external.length !== 1) return {};
  try {
    const matches = await relay.findContactsByEmail(external[0].email);
    return matches.length === 1 ? { contactId: matches[0].id } : {};
  } catch {
    // Linking is a convenience; a Relay outage must not block calendar sync.
    return {};
  }
}

/**
 * Pulls calendar changes with a calendarView delta query and applies them.
 * A missing or expired delta token (410) restarts from a full window, which is
 * also how missed notifications and dead-lettered ones are reconciled.
 */
export async function syncCalendar(connectionId: string, graph: GraphClient, relay: RelayApi | null) {
  const connection = await prisma.microsoftConnection.findUniqueOrThrow({ where: { id: connectionId } });
  const counts: Record<ApplyResult, number> = { created: 0, updated: 0, rescheduled: 0, cancelled: 0, unchanged: 0, ignored: 0 };

  const now = Date.now();
  let link =
    connection.calendarDeltaLink ??
    GraphClient.calendarDeltaStart(new Date(now - PAST_DAYS * 86_400_000), new Date(now + FUTURE_DAYS * 86_400_000));

  for (let pages = 0; pages < 200; pages++) {
    let page;
    try {
      page = await graph.calendarDeltaPage(link);
    } catch (error) {
      if (error instanceof GraphError && error.status === 410 && connection.calendarDeltaLink) {
        await prisma.microsoftConnection.update({ where: { id: connectionId }, data: { calendarDeltaLink: null } });
        return syncCalendar(connectionId, graph, relay);
      }
      throw error;
    }
    for (const ev of page.value) counts[await applyGraphEvent(connection, ev, relay)]++;
    if (page["@odata.deltaLink"]) {
      await prisma.microsoftConnection.update({
        where: { id: connectionId },
        data: { calendarDeltaLink: page["@odata.deltaLink"], calendarSyncedAt: new Date() },
      });
      break;
    }
    if (!page["@odata.nextLink"]) break;
    link = page["@odata.nextLink"];
  }
  return counts;
}

/** Marks ended meetings completed, which queues meeting.completed for the lead timeline. */
export async function completeEndedMeetings(now = new Date()) {
  const ended = await prisma.meeting.findMany({
    where: { status: "SCHEDULED", endsAt: { lt: now }, deletedAt: null },
    take: 200,
  });
  for (const m of ended) {
    await prisma.$transaction(async (tx) => {
      const r = await tx.meeting.updateMany({ where: { id: m.id, status: "SCHEDULED" }, data: { status: "COMPLETED", version: { increment: 1 } } });
      if (r.count === 1) await recordMeetingEvent(tx, m, "meeting.completed", SYSTEM, {}, "meeting.completed");
    });
  }
  return ended.length;
}
