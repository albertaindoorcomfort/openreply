"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";
import { findUserConnection } from "@/lib/microsoft/connection";
import { GraphError } from "@/lib/microsoft/graph";
import { ConnectionUnavailableError } from "@/lib/microsoft/connection";
import {
  addNote,
  AssistantError,
  correctSummary,
  createActionItemTasks,
  generateBrief,
  importTranscript,
  linkMeeting,
  prepareFollowUp,
  recordConsent,
  setNoteDeleted,
  summarizeMeeting,
  updateNote,
} from "@/lib/meetings/assistant";
import { depsFor } from "@/lib/meetings/runtime";
import { bookMeeting, cancelMeeting, rescheduleMeeting, SchedulingError } from "@/lib/meetings/scheduling";
import { formatDay, formatTime, zonedToUtc } from "@/lib/meetings/time";
import { UNAVAILABLE_TEXT } from "@/lib/meetings/transcript";

export type ActionResult = { ok: boolean; message: string } | null;

/**
 * Server actions for the meetings workspace. Every action resolves the
 * workspace from the session, never from the form. Changing a meeting in
 * Outlook (move, cancel) is limited to the mailbox owner or a workspace
 * admin; notes and summaries are open to every member.
 */

async function session() {
  const ctx = await getCurrentWorkspaceContext();
  if (!ctx) throw new Error("Unauthorized");
  return ctx;
}

async function meetingFor(ctx: Awaited<ReturnType<typeof session>>, meetingId: string, needsOwner: boolean) {
  const meeting = await prisma.meeting.findFirst({
    where: { id: meetingId, workspaceId: ctx.workspaceId, deletedAt: null },
    include: { connection: { select: { userId: true } } },
  });
  if (!meeting) return null;
  if (needsOwner && meeting.connection.userId !== ctx.userId && !canManageWorkspace(ctx.role)) return null;
  return meeting;
}

function explain(error: unknown): ActionResult {
  if (error instanceof SchedulingError) {
    const text: Record<SchedulingError["code"], string> = {
      APPROVAL_REQUIRED: "This needs an approval before it can go out.",
      AVAILABILITY_UNKNOWN: `${error.message}. Nothing was booked.`,
      VERSION_CONFLICT: "Someone changed this meeting while you were editing. Reload and try again.",
      NOT_FOUND: "Meeting not found.",
      INVALID: error.message,
      NOT_ORGANIZER: error.message,
    };
    return { ok: false, message: text[error.code] };
  }
  if (error instanceof AssistantError) {
    const text = { NOT_FOUND: "Not found.", VERSION_CONFLICT: "This changed since you opened it. Reload and try again.", INVALID: "Add notes first." };
    return { ok: false, message: text[error.code] };
  }
  if (error instanceof ConnectionUnavailableError) return { ok: false, message: "Your Microsoft 365 connection needs to be renewed. Reconnect it from Meetings › Connect." };
  if (error instanceof GraphError) return { ok: false, message: `Microsoft 365 refused the request (${error.status}). Nothing was changed.` };
  throw error;
}

const str = (v: FormDataEntryValue | null) => (typeof v === "string" ? v.trim() : "");

export async function bookAction(_: ActionResult, form: FormData): Promise<ActionResult> {
  const ctx = await session();
  const connection = await findUserConnection(ctx.workspaceId, ctx.userId);
  if (!connection || connection.status !== "ACTIVE") return { ok: false, message: "Connect your Microsoft 365 calendar first." };

  const parsed = z
    .object({
      title: z.string().min(1).max(200),
      start: z.string(),
      duration: z.coerce.number().int().min(5).max(480),
      attendees: z.string().max(2000),
      teams: z.string().optional(),
      location: z.string().max(200),
      agenda: z.string().max(4000),
      contactId: z.string().max(100),
      requestId: z.string().min(8).max(100),
    })
    .safeParse(Object.fromEntries(["title", "start", "duration", "attendees", "teams", "location", "agenda", "contactId", "requestId"].map((k) => [k, str(form.get(k)) || (k === "teams" ? undefined : "")])));
  if (!parsed.success) return { ok: false, message: "Check the title, time and duration." };
  const f = parsed.data;
  const start = zonedToUtc(f.start, connection.timezone);
  if (!start) return { ok: false, message: "Pick a start time." };
  const emails = f.attendees.split(/[\s,;]+/).filter(Boolean);
  if (emails.some((e) => !z.string().email().safeParse(e).success)) return { ok: false, message: "One of the attendee addresses is not valid." };

  try {
    const r = await bookMeeting(
      {
        workspaceId: ctx.workspaceId,
        connectionId: connection.id,
        title: f.title,
        start,
        durationMinutes: f.duration,
        attendees: emails.map((email) => ({ email })),
        teams: f.teams === "on",
        location: f.location || null,
        agenda: f.agenda || null,
        contactId: f.contactId || null,
        idempotencyKey: `ui:${ctx.userId}:${f.requestId}`,
      },
      { kind: "human", userId: ctx.userId },
      depsFor(connection.id)
    );
    revalidatePath("/calendar");
    revalidatePath("/agenda");
    if (r.status === "booked") {
      return { ok: true, message: `${r.duplicate ? "Already booked" : "Booked"}: ${formatDay(r.meeting.startsAt, connection.timezone)} at ${formatTime(r.meeting.startsAt, connection.timezone)}.` };
    }
    const alts = r.alternatives.map((a) => `${formatDay(a.start, connection.timezone)} ${formatTime(a.start, connection.timezone)}`);
    return { ok: false, message: `That time is taken${r.conflicts[0] ? ` on ${r.conflicts[0].who}'s calendar` : ""}. Free: ${alts.join("; ") || "nothing in the next week"}.` };
  } catch (error) {
    return explain(error);
  }
}

export async function rescheduleAction(_: ActionResult, form: FormData): Promise<ActionResult> {
  const ctx = await session();
  const meeting = await meetingFor(ctx, str(form.get("meetingId")), true);
  if (!meeting) return { ok: false, message: "Only the organizer or an admin can move this meeting." };
  const start = zonedToUtc(str(form.get("start")), meeting.timezone);
  if (!start) return { ok: false, message: "Pick a new time." };
  try {
    const r = await rescheduleMeeting(
      { workspaceId: ctx.workspaceId, meetingId: meeting.id, start, expectedVersion: Number(form.get("version")) },
      { kind: "human", userId: ctx.userId },
      depsFor(meeting.connectionId)
    );
    revalidatePath(`/meetings/${meeting.id}`);
    if (r.status === "rescheduled") return { ok: true, message: `Moved to ${formatDay(r.meeting.startsAt, meeting.timezone)} at ${formatTime(r.meeting.startsAt, meeting.timezone)}.` };
    if (r.status === "changed_in_outlook") return { ok: false, message: "This meeting was changed in Outlook. The page now shows Outlook's version; try again if you still want to move it." };
    return { ok: false, message: `That time is taken. Free: ${r.alternatives.map((a) => `${formatDay(a.start, meeting.timezone)} ${formatTime(a.start, meeting.timezone)}`).join("; ") || "nothing in the next week"}.` };
  } catch (error) {
    return explain(error);
  }
}

export async function cancelAction(_: ActionResult, form: FormData): Promise<ActionResult> {
  const ctx = await session();
  const meeting = await meetingFor(ctx, str(form.get("meetingId")), true);
  if (!meeting) return { ok: false, message: "Only the organizer or an admin can cancel this meeting." };
  try {
    await cancelMeeting(
      { workspaceId: ctx.workspaceId, meetingId: meeting.id, expectedVersion: Number(form.get("version")), comment: str(form.get("comment")).slice(0, 1000) },
      { kind: "human", userId: ctx.userId },
      depsFor(meeting.connectionId)
    );
    revalidatePath(`/meetings/${meeting.id}`);
    return { ok: true, message: "Cancelled. Attendees were notified by Outlook." };
  } catch (error) {
    return explain(error);
  }
}

export async function linkAction(_: ActionResult, form: FormData): Promise<ActionResult> {
  const ctx = await session();
  const meeting = await meetingFor(ctx, str(form.get("meetingId")), false);
  if (!meeting) return { ok: false, message: "Meeting not found." };
  try {
    await linkMeeting(
      { workspaceId: ctx.workspaceId, meetingId: meeting.id, contactId: str(form.get("contactId")) || null, opportunityId: str(form.get("opportunityId")) || null, expectedVersion: Number(form.get("version")) },
      { kind: "USER", id: ctx.userId }
    );
    revalidatePath(`/meetings/${meeting.id}`);
    return { ok: true, message: "Linked. Meeting history will appear on the lead's timeline." };
  } catch (error) {
    return explain(error);
  }
}

export async function briefAction(_: ActionResult, form: FormData): Promise<ActionResult> {
  const ctx = await session();
  const meeting = await meetingFor(ctx, str(form.get("meetingId")), false);
  if (!meeting) return { ok: false, message: "Meeting not found." };
  try {
    const b = await generateBrief(ctx.workspaceId, meeting.id, depsFor(meeting.connectionId));
    revalidatePath(`/meetings/${meeting.id}`);
    return { ok: true, message: b.producer === "facts" ? "Brief ready (facts only; AIC OS's model is not connected)." : "Brief ready." };
  } catch (error) {
    return explain(error);
  }
}

export async function consentAction(_: ActionResult, form: FormData): Promise<ActionResult> {
  const ctx = await session();
  const meeting = await meetingFor(ctx, str(form.get("meetingId")), false);
  if (!meeting) return { ok: false, message: "Meeting not found." };
  const granted = str(form.get("decision")) === "granted";
  await recordConsent(
    {
      workspaceId: ctx.workspaceId,
      meetingId: meeting.id,
      kind: "TRANSCRIPTION",
      granted,
      method: str(form.get("method")) || "VERBAL",
      participants: str(form.get("participants")).split(/[\s,;]+/).filter(Boolean).slice(0, 50),
    },
    ctx.userId
  );
  revalidatePath(`/meetings/${meeting.id}`);
  return { ok: true, message: granted ? "Consent recorded." : "Recorded that transcription is not allowed." };
}

export async function addNoteAction(_: ActionResult, form: FormData): Promise<ActionResult> {
  const ctx = await session();
  const meeting = await meetingFor(ctx, str(form.get("meetingId")), false);
  if (!meeting) return { ok: false, message: "Meeting not found." };
  try {
    await addNote({ workspaceId: ctx.workspaceId, meetingId: meeting.id, body: str(form.get("body")) }, { kind: "USER", id: ctx.userId });
    revalidatePath(`/meetings/${meeting.id}`);
    return { ok: true, message: "Saved." };
  } catch (error) {
    return explain(error);
  }
}

export async function editNoteAction(_: ActionResult, form: FormData): Promise<ActionResult> {
  const ctx = await session();
  try {
    const n = await updateNote(
      { workspaceId: ctx.workspaceId, noteId: str(form.get("noteId")), body: str(form.get("body")), expectedVersion: Number(form.get("version")) },
      { kind: "USER", id: ctx.userId }
    );
    revalidatePath(`/meetings/${n.meetingId}`);
    return { ok: true, message: "Saved." };
  } catch (error) {
    return explain(error);
  }
}

export async function deleteNoteAction(_: ActionResult, form: FormData): Promise<ActionResult> {
  const ctx = await session();
  try {
    const deleted = str(form.get("deleted")) === "true";
    const n = await setNoteDeleted({ workspaceId: ctx.workspaceId, noteId: str(form.get("noteId")), deleted }, { kind: "USER", id: ctx.userId });
    revalidatePath(`/meetings/${n.meetingId}`);
    return { ok: true, message: deleted ? "Deleted. You can restore it below." : "Restored." };
  } catch (error) {
    return explain(error);
  }
}

export async function transcriptAction(_: ActionResult, form: FormData): Promise<ActionResult> {
  const ctx = await session();
  const meeting = await meetingFor(ctx, str(form.get("meetingId")), false);
  if (!meeting) return { ok: false, message: "Meeting not found." };
  try {
    const r = await importTranscript(ctx.workspaceId, meeting.id, { kind: "USER", id: ctx.userId }, depsFor(meeting.connectionId));
    revalidatePath(`/meetings/${meeting.id}`);
    return r.ok ? { ok: true, message: "Transcript imported." } : { ok: false, message: UNAVAILABLE_TEXT[r.reason] };
  } catch (error) {
    return explain(error);
  }
}

export async function summarizeAction(_: ActionResult, form: FormData): Promise<ActionResult> {
  const ctx = await session();
  const meeting = await meetingFor(ctx, str(form.get("meetingId")), false);
  if (!meeting) return { ok: false, message: "Meeting not found." };
  try {
    const s = await summarizeMeeting(ctx.workspaceId, meeting.id, depsFor(meeting.connectionId));
    revalidatePath(`/meetings/${meeting.id}`);
    return { ok: true, message: s.producer === "heuristic" ? "Summary drafted from marked lines (AIC OS's model is not connected). Review and correct it." : "Summary drafted. Review and correct it." };
  } catch (error) {
    return explain(error);
  }
}

export async function correctSummaryAction(_: ActionResult, form: FormData): Promise<ActionResult> {
  const ctx = await session();
  const lines = (name: string) => str(form.get(name)).split("\n").map((l) => l.trim()).filter(Boolean);
  try {
    const s = await correctSummary(
      {
        workspaceId: ctx.workspaceId,
        summaryId: str(form.get("summaryId")),
        summary: str(form.get("summary")),
        decisions: lines("decisions"),
        actionItems: lines("actionItems").map((title) => ({ title: title.slice(0, 200), owner: null, dueAt: null, relayTaskId: null })),
        reason: str(form.get("reason")) || null,
      },
      ctx.userId
    );
    revalidatePath(`/meetings/${s.meetingId}`);
    return { ok: true, message: "Correction saved and kept as feedback for AIC OS's evaluation." };
  } catch (error) {
    return explain(error);
  }
}

export async function tasksAction(_: ActionResult, form: FormData): Promise<ActionResult> {
  const ctx = await session();
  const meeting = await meetingFor(ctx, str(form.get("meetingId")), false);
  if (!meeting) return { ok: false, message: "Meeting not found." };
  try {
    const r = await createActionItemTasks(ctx.workspaceId, meeting.id, depsFor(meeting.connectionId), ctx.userId);
    revalidatePath(`/meetings/${meeting.id}`);
    if (r.unavailable) return { ok: false, message: "The lead inbox is not connected, so tasks could not be created." };
    return { ok: true, message: r.created ? `${r.created} task${r.created === 1 ? "" : "s"} created with reminders.` : "Tasks already exist for these action items." };
  } catch (error) {
    return explain(error);
  }
}

export async function followUpAction(_: ActionResult, form: FormData): Promise<ActionResult> {
  const ctx = await session();
  const meeting = await meetingFor(ctx, str(form.get("meetingId")), false);
  if (!meeting) return { ok: false, message: "Meeting not found." };
  try {
    const f = await prepareFollowUp(ctx.workspaceId, meeting.id, { kind: "USER", id: ctx.userId }, depsFor(meeting.connectionId));
    revalidatePath(`/meetings/${meeting.id}`);
    const where = {
      RELAY_DRAFT: "Draft added to the lead's conversation in the inbox. It goes out only after approval.",
      OUTLOOK_DRAFT: "Draft saved in your Outlook Drafts folder. Review and send it from Outlook.",
      PROPOSED: "Draft prepared below. There is no external attendee to send it to.",
      DISCARDED: "Discarded.",
    };
    return { ok: true, message: where[f.status] };
  } catch (error) {
    return explain(error);
  }
}
