import type { Prisma } from "@/app/generated/prisma/client";

export type Actor = { kind: "USER" | "AGENT" | "SYSTEM"; id: string | null };
export const SYSTEM: Actor = { kind: "SYSTEM", id: "meetings" };
export const CARLA: Actor = { kind: "AGENT", id: "carla" };

/** Timeline event types, plus "feedback" for corrections forwarded to POST /feedback. */
type RelayType = "meeting.scheduled" | "meeting.rescheduled" | "meeting.completed" | "meeting.notes_linked" | "feedback";

/**
 * Appends to the meeting's history in the caller's transaction. A relayType
 * also queues the event for the Relay timeline (pushed by the outbox job), so
 * the local change and the timeline entry can never disagree.
 */
export function recordMeetingEvent(
  tx: Prisma.TransactionClient,
  meeting: { id: string; workspaceId: string },
  type: string,
  actor: Actor,
  payload: Record<string, unknown> = {},
  relayType?: RelayType
) {
  return tx.meetingEvent.create({
    data: {
      workspaceId: meeting.workspaceId,
      meetingId: meeting.id,
      type,
      actorKind: actor.kind,
      actorId: actor.id,
      payload: payload as Prisma.InputJsonValue,
      relayType: relayType ?? null,
    },
  });
}

export interface Attendee {
  email: string;
  name: string | null;
  type: string;
  response: string | null;
  internal: boolean;
}

export function internalDomains(organizerEmail: string): string[] {
  const configured = (process.env.AIC_INTERNAL_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  const own = organizerEmail.split("@")[1]?.toLowerCase();
  return own ? [...new Set([...configured, own])] : configured;
}

export function isInternal(email: string, domains: string[]): boolean {
  const domain = email.split("@")[1]?.toLowerCase();
  return !!domain && domains.includes(domain);
}

export function readAttendees(value: unknown): Attendee[] {
  return Array.isArray(value) ? (value as Attendee[]) : [];
}
