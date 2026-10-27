import { createHmac, timingSafeEqual } from "crypto";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { findConnectionByEmail } from "@/lib/microsoft/connection";
import { CARLA } from "./events";
import { AssistantError, createActionItemTasks, generateBrief, prepareFollowUp, summarizeMeeting } from "./assistant";
import { depsFor } from "./runtime";
import { bookMeeting, checkAvailability, rescheduleMeeting, SchedulingError, type Authorization } from "./scheduling";

/**
 * Apollo's remote tool adapter for meetings (contracts.md section 3).
 *
 * Apollo has already run allowlist, schema, authorization, prechecks and
 * approvals before it calls here; this side verifies the signature, acts only
 * for the tenant in the request, and still refuses an external invite that
 * arrives without an approval id (defence in depth).
 */

const MAX_SKEW_S = 300;

export function verifyAicSignature(rawBody: string, timestamp: string | null, signature: string | null, secret: string, nowS = Date.now() / 1000) {
  if (!timestamp || !signature?.startsWith("v1=")) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowS - ts) > MAX_SKEW_S) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const got = Buffer.from(signature.slice(3), "hex");
  const want = Buffer.from(expected, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

/** AIC_TENANT_WORKSPACES="ten_abc=workspaceId,ten_def=workspaceId" */
export function workspaceForTenant(tenantId: string): string | null {
  for (const pair of (process.env.AIC_TENANT_WORKSPACES ?? "").split(",")) {
    const [t, w] = pair.split("=").map((s) => s.trim());
    if (t && w && t === tenantId) return w;
  }
  return null;
}

export const envelope = z.object({
  tenantId: z.string(),
  agentId: z.string(),
  userId: z.string().nullish(),
  taskId: z.string().nullish(),
  sessionId: z.string().nullish(),
  approvalId: z.string().nullish(),
  args: z.record(z.string(), z.unknown()),
});

const iso = z.string().refine((v) => !Number.isNaN(Date.parse(v)), "ISO date-time");
const attendee = z.object({ email: z.string().email(), name: z.string().max(120).optional() }).strict();

/** Argument schemas, also registered with Apollo (minus the executor). */
export const MEETING_TOOLS = {
  "meetings.check_availability": z
    .object({ mailbox: z.string().email(), start: iso, durationMinutes: z.number().int().min(5).max(480), attendees: z.array(z.string().email()).max(20).default([]) })
    .strict(),
  "meetings.upcoming": z.object({ mailbox: z.string().email(), days: z.number().int().min(1).max(31).default(7) }).strict(),
  "meetings.book": z
    .object({
      mailbox: z.string().email(),
      title: z.string().min(1).max(200),
      start: iso,
      durationMinutes: z.number().int().min(5).max(480),
      attendees: z.array(attendee).max(20),
      teams: z.boolean().default(true),
      location: z.string().max(200).nullish(),
      agenda: z.string().max(4000).nullish(),
      contactId: z.string().nullish(),
      opportunityId: z.string().nullish(),
      conversationId: z.string().nullish(),
    })
    .strict(),
  "meetings.reschedule": z
    .object({ meetingId: z.string(), start: iso, durationMinutes: z.number().int().min(5).max(480).optional(), expectedVersion: z.number().int() })
    .strict(),
  "meetings.brief": z.object({ meetingId: z.string() }).strict(),
  "meetings.summarize": z.object({ meetingId: z.string() }).strict(),
  "meetings.create_action_tasks": z.object({ meetingId: z.string() }).strict(),
  "meetings.prepare_follow_up": z.object({ meetingId: z.string() }).strict(),
} as const;
export type MeetingToolName = keyof typeof MEETING_TOOLS;

export class ToolError extends Error {
  constructor(readonly status: number, readonly code: string, readonly details: unknown[] = []) {
    super(code);
  }
}

async function connectionFor(workspaceId: string, mailbox: string) {
  const c = await findConnectionByEmail(workspaceId, mailbox);
  if (!c) throw new ToolError(404, "MAILBOX_NOT_CONNECTED");
  return c;
}

async function meetingConnection(workspaceId: string, meetingId: string) {
  const m = await prisma.meeting.findFirst({ where: { id: meetingId, workspaceId, deletedAt: null } });
  if (!m) throw new ToolError(404, "NOT_FOUND");
  return m.connectionId;
}

const slot = (i: { start: Date; end: Date }) => ({ start: i.start.toISOString(), end: i.end.toISOString() });

export async function runMeetingTool(
  name: MeetingToolName,
  workspaceId: string,
  req: z.infer<typeof envelope>,
  idempotencyKey: string
): Promise<Record<string, unknown>> {
  const parsed = MEETING_TOOLS[name].safeParse(req.args);
  if (!parsed.success) throw new ToolError(400, "INVALID_ARGS", parsed.error.issues.map((i) => i.path.join(".")));
  const auth: Authorization = { kind: "apollo", approvalId: req.approvalId ?? null, agentId: req.agentId };

  try {
    switch (name) {
      case "meetings.check_availability": {
        const a = MEETING_TOOLS[name].parse(req.args);
        const c = await connectionFor(workspaceId, a.mailbox);
        const r = await checkAvailability({ connectionId: c.id, workspaceId, start: new Date(a.start), durationMinutes: a.durationMinutes, attendees: a.attendees }, depsFor(c.id));
        return { free: r.free, conflicts: r.conflicts.map((b) => ({ ...slot(b), who: b.who, status: b.status })), alternatives: r.alternatives.map(slot) };
      }
      case "meetings.upcoming": {
        const a = MEETING_TOOLS[name].parse(req.args);
        const c = await connectionFor(workspaceId, a.mailbox);
        const now = new Date();
        const meetings = await prisma.meeting.findMany({
          where: { workspaceId, connectionId: c.id, deletedAt: null, status: "SCHEDULED", startsAt: { gte: now, lt: new Date(now.getTime() + a.days * 86_400_000) } },
          orderBy: { startsAt: "asc" },
          take: 50,
          select: { id: true, title: true, startsAt: true, endsAt: true, contactId: true, opportunityId: true, isOnline: true, version: true },
        });
        return { meetings };
      }
      case "meetings.book": {
        const a = MEETING_TOOLS[name].parse(req.args);
        const c = await connectionFor(workspaceId, a.mailbox);
        const r = await bookMeeting(
          { ...a, workspaceId, connectionId: c.id, start: new Date(a.start), idempotencyKey: `apollo:${idempotencyKey}` },
          auth,
          depsFor(c.id)
        );
        return r.status === "booked"
          ? { status: "booked", meetingId: r.meeting.id, start: r.meeting.startsAt.toISOString(), duplicate: r.duplicate, version: r.meeting.version }
          : { status: "conflict", conflicts: r.conflicts.map(slot), alternatives: r.alternatives.map(slot) };
      }
      case "meetings.reschedule": {
        const a = MEETING_TOOLS[name].parse(req.args);
        const connectionId = await meetingConnection(workspaceId, a.meetingId);
        const r = await rescheduleMeeting({ ...a, workspaceId, start: new Date(a.start) }, auth, depsFor(connectionId));
        if (r.status === "conflict") return { status: "conflict", conflicts: r.conflicts.map(slot), alternatives: r.alternatives.map(slot) };
        return { status: r.status, start: r.meeting.startsAt.toISOString(), version: r.meeting.version };
      }
      case "meetings.brief": {
        const a = MEETING_TOOLS[name].parse(req.args);
        const b = await generateBrief(workspaceId, a.meetingId, depsFor(await meetingConnection(workspaceId, a.meetingId)));
        return { briefId: b.id, body: b.body, evidence: b.evidence, producer: b.producer };
      }
      case "meetings.summarize": {
        const a = MEETING_TOOLS[name].parse(req.args);
        const s = await summarizeMeeting(workspaceId, a.meetingId, depsFor(await meetingConnection(workspaceId, a.meetingId)));
        return { summaryId: s.id, summary: s.summary, decisions: s.decisions, actionItems: s.actionItems, producer: s.producer };
      }
      case "meetings.create_action_tasks": {
        const a = MEETING_TOOLS[name].parse(req.args);
        return await createActionItemTasks(workspaceId, a.meetingId, depsFor(await meetingConnection(workspaceId, a.meetingId)), null);
      }
      case "meetings.prepare_follow_up": {
        const a = MEETING_TOOLS[name].parse(req.args);
        const f = await prepareFollowUp(workspaceId, a.meetingId, CARLA, depsFor(await meetingConnection(workspaceId, a.meetingId)));
        return { followUpId: f.id, status: f.status, relayDraftId: f.relayDraftId, outlookDraftId: f.outlookDraftId };
      }
    }
  } catch (error) {
    if (error instanceof SchedulingError) throw new ToolError(error.code === "APPROVAL_REQUIRED" ? 403 : 409, error.code);
    if (error instanceof AssistantError) throw new ToolError(error.code === "NOT_FOUND" ? 404 : 409, error.code);
    throw error;
  }
}
