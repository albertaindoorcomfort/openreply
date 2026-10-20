import { createHash } from "crypto";
import type { Meeting, MicrosoftConnection, Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { GraphError, type GraphClient } from "@/lib/microsoft/graph";
import { conflictsFor, proposeSlots, type BusyBlock, type Interval } from "./availability";
import { internalDomains, isInternal, readAttendees, recordMeetingEvent, type Actor, type Attendee } from "./events";
import { applyGraphEvent } from "./sync";
import type { RelayApi } from "./relay-client";

/**
 * Booking, rescheduling and cancelling against Outlook.
 *
 * Rules that hold for every path:
 * - Availability is read from Outlook (getSchedule) immediately before a
 *   confirmed booking or move. If any internal calendar cannot be read, the
 *   booking is refused rather than assumed free.
 * - An invite, update or cancellation that reaches someone outside AIC is a
 *   customer-facing send. A person clicking the button is that approval; an
 *   agent needs an Apollo approval id (comms:send) or is refused.
 * - Graph's transactionId is the meeting id, so a retried booking can never
 *   create a second Outlook event.
 * - Moves send If-Match with the last changeKey, so an edit made in Outlook
 *   in the meantime wins and is reported as a conflict, not overwritten.
 */

export type Authorization = { kind: "human"; userId: string } | { kind: "apollo"; approvalId: string | null; agentId: string };

export interface SchedulingDeps {
  graph: GraphClient;
  relay: RelayApi | null;
  now?: () => Date;
}

export class SchedulingError extends Error {
  constructor(readonly code: "APPROVAL_REQUIRED" | "AVAILABILITY_UNKNOWN" | "VERSION_CONFLICT" | "NOT_FOUND" | "INVALID" | "NOT_ORGANIZER", message?: string) {
    super(message ?? code);
  }
}

function actorOf(auth: Authorization): Actor {
  return auth.kind === "human" ? { kind: "USER", id: auth.userId } : { kind: "AGENT", id: auth.agentId };
}

function requireApprovalIfExternal(attendees: { email: string }[], organizerEmail: string, auth: Authorization) {
  const domains = internalDomains(organizerEmail);
  const external = attendees.filter((a) => !isInternal(a.email, domains));
  if (external.length && auth.kind === "apollo" && !auth.approvalId) {
    throw new SchedulingError("APPROVAL_REQUIRED", "Invites to people outside AIC need an approval");
  }
  return external.length > 0;
}

/**
 * Busy blocks for the internal people on a meeting. External calendars are
 * not visible to Graph, so customers are never assumed free or busy.
 */
export async function gatherBusy(
  connection: Pick<MicrosoftConnection, "id" | "workspaceId" | "email">,
  graph: GraphClient,
  attendeeEmails: string[],
  window: Interval,
  exclude?: Pick<Meeting, "id" | "startsAt" | "endsAt">
): Promise<BusyBlock[]> {
  const domains = internalDomains(connection.email);
  const internal = [...new Set([connection.email, ...attendeeEmails].map((e) => e.toLowerCase()))].filter((e) =>
    isInternal(e, domains)
  );
  const schedule = await graph.getSchedule(internal, window.start, window.end);
  const busy: BusyBlock[] = [];
  for (const email of internal) {
    const items = schedule.get(email);
    if (items === null || items === undefined) throw new SchedulingError("AVAILABILITY_UNKNOWN", `Could not read the calendar of ${email}`);
    for (const i of items) {
      // The meeting being moved still occupies its old slot in Outlook.
      if (exclude && i.start.getTime() === exclude.startsAt.getTime() && i.end.getTime() === exclude.endsAt.getTime()) continue;
      busy.push({ who: email, status: i.status, start: i.start, end: i.end, source: "outlook" });
    }
  }
  // Bookings made here that Outlook has not confirmed yet still hold their slot.
  const pending = await prisma.meeting.findMany({
    where: {
      workspaceId: connection.workspaceId,
      connectionId: connection.id,
      graphEventId: null,
      status: "SCHEDULED",
      deletedAt: null,
      startsAt: { lt: window.end },
      endsAt: { gt: window.start },
      ...(exclude ? { id: { not: exclude.id } } : {}),
    },
  });
  for (const m of pending) busy.push({ who: connection.email, status: "busy", start: m.startsAt, end: m.endsAt, source: "aic", meetingId: m.id });
  return busy;
}

async function settingsFor(workspaceId: string) {
  return (
    (await prisma.meetingSettings.findUnique({ where: { workspaceId } })) ?? {
      businessHoursStart: 8,
      businessHoursEnd: 17,
    }
  );
}

export interface AvailabilityQuery {
  connectionId: string;
  workspaceId: string;
  start: Date;
  durationMinutes: number;
  attendees: string[];
  bufferMinutes?: number;
  excludeMeetingId?: string;
}

export async function checkAvailability(q: AvailabilityQuery, deps: SchedulingDeps) {
  const connection = await prisma.microsoftConnection.findFirstOrThrow({ where: { id: q.connectionId, workspaceId: q.workspaceId } });
  const slot = { start: q.start, end: new Date(q.start.getTime() + q.durationMinutes * 60_000) };
  const exclude = q.excludeMeetingId
    ? await prisma.meeting.findFirst({ where: { id: q.excludeMeetingId, workspaceId: q.workspaceId } })
    : null;
  // Look at the whole week around the slot so alternatives come from the same read.
  const window = { start: new Date(slot.start.getTime() - 86_400_000), end: new Date(slot.start.getTime() + 7 * 86_400_000) };
  const busy = await gatherBusy(connection, deps.graph, q.attendees, window, exclude ?? undefined);
  const conflicts = conflictsFor(slot, busy, q.bufferMinutes ?? 0);
  const settings = await settingsFor(q.workspaceId);
  const now = deps.now?.() ?? new Date();
  const alternatives = conflicts.length
    ? proposeSlots({ start: slot.start, end: window.end }, busy, {
        timeZone: connection.timezone,
        businessHoursStart: settings.businessHoursStart,
        businessHoursEnd: settings.businessHoursEnd,
        durationMinutes: q.durationMinutes,
        bufferMinutes: q.bufferMinutes ?? 0,
        notBefore: new Date(now.getTime() + 60 * 60_000),
      })
    : [];
  return { free: conflicts.length === 0, slot, conflicts, alternatives };
}

export interface BookInput {
  workspaceId: string;
  connectionId: string;
  title: string;
  start: Date;
  durationMinutes: number;
  attendees: { email: string; name?: string }[];
  teams: boolean;
  location?: string | null;
  agenda?: string | null;
  contactId?: string | null;
  opportunityId?: string | null;
  conversationId?: string | null;
  idempotencyKey: string;
}

export type BookResult =
  | { status: "booked"; meeting: Meeting; duplicate: boolean }
  | { status: "conflict"; conflicts: BusyBlock[]; alternatives: Interval[] };

export const meetingIdFor = (workspaceId: string, idempotencyKey: string) =>
  `mtg${createHash("sha256").update(`${workspaceId}|${idempotencyKey}`).digest("hex").slice(0, 22)}`;

export async function bookMeeting(input: BookInput, auth: Authorization, deps: SchedulingDeps): Promise<BookResult> {
  if (input.durationMinutes < 5 || input.durationMinutes > 8 * 60) throw new SchedulingError("INVALID", "Duration must be 5 minutes to 8 hours");
  const connection = await prisma.microsoftConnection.findFirstOrThrow({ where: { id: input.connectionId, workspaceId: input.workspaceId } });
  const id = meetingIdFor(input.workspaceId, input.idempotencyKey);

  const existing = await prisma.meeting.findUnique({ where: { id } });
  if (existing && existing.workspaceId === input.workspaceId && !existing.deletedAt) {
    return { status: "booked", meeting: existing, duplicate: true };
  }

  const attendees = input.attendees.map((a) => ({ email: a.email.trim().toLowerCase(), name: a.name }));
  requireApprovalIfExternal(attendees, connection.email, auth);

  const availability = await checkAvailability(
    { connectionId: connection.id, workspaceId: input.workspaceId, start: input.start, durationMinutes: input.durationMinutes, attendees: attendees.map((a) => a.email) },
    deps
  );
  if (!availability.free) return { status: "conflict", conflicts: availability.conflicts, alternatives: availability.alternatives };

  const domains = internalDomains(connection.email);
  const stored: Attendee[] = attendees.map((a) => ({ email: a.email, name: a.name ?? null, type: "required", response: null, internal: isInternal(a.email, domains) }));
  const actor = actorOf(auth);
  const meeting = await prisma.$transaction(async (tx) => {
    const m = await tx.meeting.upsert({
      where: { id },
      // A row left by a failed earlier attempt is reused with the same id.
      update: { deletedAt: null, status: "SCHEDULED", startsAt: availability.slot.start, endsAt: availability.slot.end },
      create: {
        id,
        workspaceId: input.workspaceId,
        connectionId: connection.id,
        title: input.title,
        startsAt: availability.slot.start,
        endsAt: availability.slot.end,
        timezone: connection.timezone,
        location: input.location ?? null,
        isOnline: input.teams,
        organizerEmail: connection.email,
        attendees: stored as unknown as Prisma.InputJsonValue,
        source: "AIC",
        contactId: input.contactId ?? null,
        opportunityId: input.opportunityId ?? null,
        conversationId: input.conversationId ?? null,
      },
    });
    await recordMeetingEvent(tx, m, "meeting.booking_requested", actor, { approvalId: auth.kind === "apollo" ? auth.approvalId : null });
    return m;
  });

  let created;
  try {
    created = await deps.graph.createEvent({
      subject: input.title,
      body: input.agenda ?? "",
      start: availability.slot.start,
      end: availability.slot.end,
      attendees,
      location: input.location,
      teams: input.teams,
      transactionId: meeting.id,
    });
  } catch (error) {
    // Hide the slot hold. If Graph did create the event, sync claims it by transactionId.
    await prisma.$transaction(async (tx) => {
      await tx.meeting.update({ where: { id: meeting.id }, data: { deletedAt: new Date() } });
      await recordMeetingEvent(tx, meeting, "meeting.booking_failed", actor, {
        error: error instanceof GraphError ? `${error.status} ${error.code}` : "network",
      });
    });
    throw error;
  }

  const booked = await prisma.$transaction(async (tx) => {
    const current = await tx.meeting.findUniqueOrThrow({ where: { id: meeting.id } });
    // A webhook can land before this line; sync then already claimed the event and logged it.
    if (current.graphEventId) return current;
    const m = await tx.meeting.update({
      where: { id: meeting.id },
      data: {
        graphEventId: created.id,
        iCalUId: created.iCalUId ?? null,
        changeKey: created.changeKey ?? null,
        joinUrl: created.onlineMeeting?.joinUrl ?? null,
        lastSyncedAt: new Date(),
        version: { increment: 1 },
      },
    });
    await recordMeetingEvent(
      tx,
      m,
      "meeting.scheduled",
      actor,
      { start: m.startsAt.toISOString(), end: m.endsAt.toISOString(), attendees: attendees.map((a) => a.email), teams: input.teams },
      "meeting.scheduled"
    );
    return m;
  });
  return { status: "booked", meeting: booked, duplicate: false };
}

export interface RescheduleInput {
  workspaceId: string;
  meetingId: string;
  start: Date;
  durationMinutes?: number;
  expectedVersion: number;
}

export type RescheduleResult =
  | { status: "rescheduled"; meeting: Meeting }
  | { status: "conflict"; conflicts: BusyBlock[]; alternatives: Interval[] }
  | { status: "changed_in_outlook"; meeting: Meeting };

export async function rescheduleMeeting(input: RescheduleInput, auth: Authorization, deps: SchedulingDeps): Promise<RescheduleResult> {
  const meeting = await prisma.meeting.findFirst({ where: { id: input.meetingId, workspaceId: input.workspaceId, deletedAt: null } });
  if (!meeting || !meeting.graphEventId) throw new SchedulingError("NOT_FOUND");
  const duration = input.durationMinutes ?? Math.round((meeting.endsAt.getTime() - meeting.startsAt.getTime()) / 60_000);
  // A retry of a move that already happened (Apollo retries after a timeout) is a success, not a conflict.
  const alreadyThere = (m: Meeting) =>
    m.startsAt.getTime() === input.start.getTime() && m.endsAt.getTime() === input.start.getTime() + duration * 60_000;
  if (alreadyThere(meeting)) return { status: "rescheduled", meeting };
  if (meeting.version !== input.expectedVersion) throw new SchedulingError("VERSION_CONFLICT");
  const connection = await prisma.microsoftConnection.findUniqueOrThrow({ where: { id: meeting.connectionId } });
  if (meeting.organizerEmail && meeting.organizerEmail !== connection.email) {
    throw new SchedulingError("NOT_ORGANIZER", "Only the organizer's mailbox can move this meeting");
  }
  const attendees = readAttendees(meeting.attendees);
  requireApprovalIfExternal(attendees, connection.email, auth);

  const availability = await checkAvailability(
    { connectionId: connection.id, workspaceId: input.workspaceId, start: input.start, durationMinutes: duration, attendees: attendees.map((a) => a.email), excludeMeetingId: meeting.id },
    deps
  );
  if (!availability.free) return { status: "conflict", conflicts: availability.conflicts, alternatives: availability.alternatives };

  try {
    const ev = await deps.graph.rescheduleEvent(
      meeting.graphEventId,
      availability.slot.start,
      availability.slot.end,
      meeting.changeKey ? `W/"${meeting.changeKey}"` : null
    );
    const updated = await prisma.$transaction(async (tx) => {
      const m = await tx.meeting.update({
        where: { id: meeting.id },
        data: { startsAt: availability.slot.start, endsAt: availability.slot.end, changeKey: ev.changeKey ?? null, version: { increment: 1 }, lastSyncedAt: new Date() },
      });
      await recordMeetingEvent(
        tx,
        m,
        "meeting.rescheduled",
        actorOf(auth),
        { from: meeting.startsAt.toISOString(), to: m.startsAt.toISOString() },
        "meeting.rescheduled"
      );
      return m;
    });
    return { status: "rescheduled", meeting: updated };
  } catch (error) {
    if (error instanceof GraphError && error.isPreconditionFailed) {
      // Someone changed it in Outlook. Pull their version and let the person decide again.
      const fresh = await deps.graph.getEvent(meeting.graphEventId);
      await applyGraphEvent(connection, fresh, deps.relay);
      const current = await prisma.meeting.findUniqueOrThrow({ where: { id: meeting.id } });
      // Our own earlier attempt may be the change: then the move is done.
      return alreadyThere(current) ? { status: "rescheduled", meeting: current } : { status: "changed_in_outlook", meeting: current };
    }
    throw error;
  }
}

export async function cancelMeeting(
  input: { workspaceId: string; meetingId: string; expectedVersion: number; comment: string },
  auth: Authorization,
  deps: SchedulingDeps
) {
  const meeting = await prisma.meeting.findFirst({ where: { id: input.meetingId, workspaceId: input.workspaceId, deletedAt: null } });
  if (!meeting || !meeting.graphEventId) throw new SchedulingError("NOT_FOUND");
  if (meeting.version !== input.expectedVersion) throw new SchedulingError("VERSION_CONFLICT");
  const connection = await prisma.microsoftConnection.findUniqueOrThrow({ where: { id: meeting.connectionId } });
  requireApprovalIfExternal(readAttendees(meeting.attendees), connection.email, auth);
  await deps.graph.cancelEvent(meeting.graphEventId, input.comment);
  return prisma.$transaction(async (tx) => {
    const m = await tx.meeting.update({ where: { id: meeting.id }, data: { status: "CANCELLED", version: { increment: 1 } } });
    await recordMeetingEvent(tx, m, "meeting.cancelled", actorOf(auth), { comment: input.comment });
    return m;
  });
}
