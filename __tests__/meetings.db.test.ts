/**
 * Meetings against a real Postgres, with Microsoft Graph and Relay faked at
 * their HTTP/API boundary. Skipped without a database:
 *
 *   TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:55432/postgres \
 *     npx vitest run __tests__/meetings.db.test.ts
 *
 * Each run builds the schema from prisma/migrations in a throwaway Postgres
 * schema and drops it afterwards.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../app/generated/prisma/client";
import { FakeGraph, FakeRelay } from "./helpers/meetings-fakes";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.ENCRYPTION_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.AIC_INTERNAL_DOMAINS = "aic.example";

const state = vi.hoisted(() => ({ db: undefined as unknown as import("../app/generated/prisma/client").PrismaClient }));
vi.mock("@/lib/db/client", () => ({
  get prisma() {
    return state.db;
  },
}));

import { encryptToken } from "../lib/meta/oauth";
import { GraphClient } from "../lib/microsoft/graph";
import { hashClientState, createCalendarSubscription, renewSubscription } from "../lib/microsoft/subscriptions";
import { ingestNotifications, processPendingNotifications } from "../lib/microsoft/notifications";
import { syncCalendar } from "../lib/meetings/sync";
import { bookMeeting, cancelMeeting, checkAvailability, rescheduleMeeting, SchedulingError } from "../lib/meetings/scheduling";
import {
  addNote,
  correctSummary,
  createActionItemTasks,
  generateBrief,
  importTranscript,
  prepareFollowUp,
  recordConsent,
  summarizeMeeting,
  updateNote,
  AssistantError,
} from "../lib/meetings/assistant";
import { pushTimelineOutbox, purgeExpiredTranscripts } from "../lib/meetings/outbox";
import { verifyAicSignature } from "../lib/meetings/tools";

const MIGRATIONS_DIR = path.join(__dirname, "..", "prisma", "migrations");
const schema = `meetings_${randomBytes(4).toString("hex")}`;
let sql: Client;

const NOW = new Date("2026-10-30T12:00:00Z");
// Monday 2 Nov 2026, 9:00 in Edmonton (UTC-7 once DST ends on 1 Nov).
const MON_9 = "2026-11-02T16:00:00Z";
const MON_930 = "2026-11-02T16:30:00Z";
const MON_10 = "2026-11-02T17:00:00Z";

let graph: FakeGraph;
let relay: FakeRelay;
let ws = "";
let connectionId = "";

function deps() {
  return { graph: new GraphClient({ get: async () => "token" }, graph.fetch, async () => undefined), relay, model: null, now: () => NOW };
}
const human = { kind: "human" as const, userId: "user_a" };
const agent = (approvalId: string | null) => ({ kind: "apollo" as const, agentId: "carla", approvalId });

async function seedWorkspace(id: string) {
  await state.db.user.create({ data: { id: `user_${id}`, email: `${id}@aic.example` } });
  await state.db.workspace.create({ data: { id, name: id, ownerId: `user_${id}` } });
  const c = await state.db.microsoftConnection.create({
    data: {
      workspaceId: id,
      userId: `user_${id}`,
      msTenantId: "tid",
      msUserId: `oid_${id}`,
      email: "owner@aic.example",
      grantedScopes: ["Calendars.ReadWrite", "OnlineMeetings.Read"],
      accessTokenEnc: encryptToken("access"),
      accessExpiresAt: new Date(Date.now() + 3_600_000),
      refreshTokenEnc: encryptToken("refresh"),
    },
  });
  return c.id;
}

describe.skipIf(!DATABASE_URL)("meetings on a real Postgres", () => {
  beforeAll(async () => {
    sql = new Client({ connectionString: DATABASE_URL });
    await sql.connect();
    await sql.query(`CREATE SCHEMA "${schema}"`);
    await sql.query(`SET search_path TO "${schema}"`);
    for (const dir of readdirSync(MIGRATIONS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
      await sql.query(readFileSync(path.join(MIGRATIONS_DIR, dir, "migration.sql"), "utf8"));
    }
    state.db = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL }, { schema }) });
  }, 60_000);

  afterAll(async () => {
    await state.db?.$disconnect();
    if (sql) {
      await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await sql.end();
    }
  });

  beforeEach(async () => {
    graph = new FakeGraph();
    relay = new FakeRelay();
    ws = `ws_${randomBytes(4).toString("hex")}`;
    connectionId = await seedWorkspace(ws);
  });

  const book = (over: Partial<Parameters<typeof bookMeeting>[0]> = {}, auth: Parameters<typeof bookMeeting>[1] = human) =>
    bookMeeting(
      {
        workspaceId: ws,
        connectionId,
        title: "Furnace estimate",
        start: new Date(MON_9),
        durationMinutes: 60,
        attendees: [{ email: "jordan@example.com", name: "Jordan Lee" }],
        teams: true,
        idempotencyKey: "k1",
        ...over,
      },
      auth,
      deps()
    );

  describe("scheduling", () => {
    it("refuses a slot that is busy in Outlook and offers free business-hours alternatives", async () => {
      graph.busy.push({ email: "owner@aic.example", start: MON_9, end: MON_10 });
      const r = await book();
      expect(r.status).toBe("conflict");
      if (r.status !== "conflict") return;
      expect(r.conflicts).toHaveLength(1);
      expect(r.alternatives[0].start).toEqual(new Date(MON_10));
      expect(graph.count("POST", /^\/me\/events$/)).toBe(0);
    });

    it("checks every internal attendee's calendar, and refuses when one cannot be read", async () => {
      graph.busy.push({ email: "tech@aic.example", start: MON_930, end: MON_10 });
      const conflict = await book({ attendees: [{ email: "tech@aic.example" }, { email: "jordan@example.com" }] });
      expect(conflict.status).toBe("conflict");

      graph.unreadableCalendars.add("tech@aic.example");
      await expect(book({ attendees: [{ email: "tech@aic.example" }], idempotencyKey: "k2" })).rejects.toMatchObject({ code: "AVAILABILITY_UNKNOWN" });
    });

    it("books once per idempotency key, even when retried", async () => {
      const first = await book();
      const again = await book();
      expect(first.status).toBe("booked");
      expect(again).toMatchObject({ status: "booked", duplicate: true });
      expect(graph.events.size).toBe(1);
      const meeting = first.status === "booked" ? first.meeting : null;
      expect(meeting?.graphEventId).toBeTruthy();
      expect(graph.calls.find((c) => c.method === "POST" && c.path === "/me/events")?.body).toMatchObject({ transactionId: meeting?.id });
    });

    it("hides a booking that Outlook rejected so it does not hold the slot", async () => {
      graph.failures.push({ match: /^POST \/me\/events$/, status: 504, sticky: true });
      await expect(book()).rejects.toBeTruthy();
      // The failed hold is hidden, so the slot is free again.
      const check = await checkAvailability({ connectionId, workspaceId: ws, start: new Date(MON_9), durationMinutes: 60, attendees: [] }, deps());
      expect(check.free).toBe(true);
    });

    it("needs an approval before an agent invites someone outside AIC", async () => {
      await expect(book({}, agent(null))).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
      expect(graph.events.size).toBe(0);
      // Internal-only holds are internal work and need none.
      expect((await book({ attendees: [{ email: "tech@aic.example" }], idempotencyKey: "k3" }, agent(null))).status).toBe("booked");
      expect((await book({ idempotencyKey: "k4", start: new Date(MON_10) }, agent("apr_1"))).status).toBe("booked");
    });

    it("recovers a booking whose Graph response was lost: sync claims the event by transactionId", async () => {
      // Graph creates the event but the response never arrives.
      const real = graph.fetch;
      graph.fetch = async (input, init) => {
        const res = await real(input, init);
        if ((init?.method ?? "GET") === "POST" && String(input).endsWith("/me/events")) throw new Error("socket hang up");
        return res;
      };
      await expect(book()).rejects.toThrow("socket hang up");
      graph.fetch = real;
      const hidden = await state.db.meeting.findFirstOrThrow({ where: { workspaceId: ws } });
      expect(hidden.deletedAt).not.toBeNull();

      await syncCalendar(connectionId, deps().graph, relay);
      const meetings = await state.db.meeting.findMany({ where: { workspaceId: ws } });
      expect(meetings).toHaveLength(1);
      expect(meetings[0]).toMatchObject({ id: hidden.id, deletedAt: null, status: "SCHEDULED" });
      expect(meetings[0].graphEventId).toBeTruthy();
    });

    it("reschedules with If-Match, and reports a concurrent Outlook edit instead of overwriting it", async () => {
      const r = await book();
      if (r.status !== "booked") throw new Error("not booked");
      const moved = await rescheduleMeeting({ workspaceId: ws, meetingId: r.meeting.id, start: new Date(MON_10), expectedVersion: r.meeting.version }, human, deps());
      expect(moved.status).toBe("rescheduled");
      if (moved.status !== "rescheduled") return;

      // A stale version from another tab is refused before anything reaches Outlook.
      await expect(
        rescheduleMeeting({ workspaceId: ws, meetingId: r.meeting.id, start: new Date(MON_9), expectedVersion: r.meeting.version }, human, deps())
      ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });

      graph.editInOutlook(moved.meeting.graphEventId!, { subject: "Renamed in Outlook" });
      const clash = await rescheduleMeeting({ workspaceId: ws, meetingId: r.meeting.id, start: new Date("2026-11-02T19:00:00Z"), expectedVersion: moved.meeting.version }, human, deps());
      expect(clash.status).toBe("changed_in_outlook");
      if (clash.status === "changed_in_outlook") expect(clash.meeting.title).toBe("Renamed in Outlook");

      const events = await state.db.meetingEvent.findMany({ where: { meetingId: r.meeting.id }, orderBy: { occurredAt: "asc" } });
      expect(events.map((e) => e.type)).toEqual(["meeting.booking_requested", "meeting.scheduled", "meeting.rescheduled"]);
    });

    it("does not let one workspace touch another workspace's meeting", async () => {
      const r = await book();
      if (r.status !== "booked") throw new Error("not booked");
      const otherWs = `ws_${randomBytes(4).toString("hex")}`;
      await seedWorkspace(otherWs);
      await expect(
        rescheduleMeeting({ workspaceId: otherWs, meetingId: r.meeting.id, start: new Date(MON_10), expectedVersion: r.meeting.version }, human, deps())
      ).rejects.toBeInstanceOf(SchedulingError);
      await expect(cancelMeeting({ workspaceId: otherWs, meetingId: r.meeting.id, expectedVersion: 1, comment: "" }, human, deps())).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(addNote({ workspaceId: otherWs, meetingId: r.meeting.id, body: "x" }, { kind: "USER", id: "u" })).rejects.toBeInstanceOf(AssistantError);
    });
  });

  describe("webhooks", () => {
    async function subscribe() {
      const row = await createCalendarSubscription(connectionId, deps().graph);
      await state.db.graphSubscription.update({ where: { id: row.id }, data: { clientStateHash: hashClientState("secret-state") } });
      return row;
    }

    it("rejects notifications with the wrong clientState and collapses duplicates", async () => {
      const sub = await subscribe();
      const ev = graph.addEvent({ subject: "Site visit", start: MON_9, end: MON_10, attendees: [{ emailAddress: { address: "jordan@example.com" } }] });
      const n = { subscriptionId: sub.graphSubscriptionId, changeType: "created", resourceData: { id: ev.id } };

      const forged = await ingestNotifications([{ ...n, clientState: "guess" }]);
      expect(forged).toMatchObject({ accepted: 0, rejected: 1 });

      const r = await ingestNotifications([{ ...n, clientState: "secret-state" }, { ...n, clientState: "secret-state" }]);
      expect(r).toMatchObject({ accepted: 1, duplicates: 1 });

      await processPendingNotifications({ graph: () => deps().graph, relay, now: () => new Date() });
      expect(await state.db.meeting.count({ where: { workspaceId: ws } })).toBe(1);

      // Graph redelivers after we processed it: a new row, applied as a no-op.
      await ingestNotifications([{ ...n, clientState: "secret-state" }]);
      await processPendingNotifications({ graph: () => deps().graph, relay, now: () => new Date() });
      expect(await state.db.meeting.count({ where: { workspaceId: ws } })).toBe(1);
      expect(await state.db.meetingEvent.count({ where: { workspaceId: ws, type: "meeting.synced" } })).toBe(1);
    });

    it("retries a notification that failed to process, then dead-letters it and asks for a full sync", async () => {
      const sub = await subscribe();
      const ev = graph.addEvent({ start: MON_9, end: MON_10, attendees: [{ emailAddress: { address: "jordan@example.com" } }] });
      await ingestNotifications([{ subscriptionId: sub.graphSubscriptionId, clientState: "secret-state", changeType: "updated", resourceData: { id: ev.id } }]);

      graph.failures.push({ match: /^GET \/me\/events\//, status: 500 });
      const t0 = new Date();
      expect(await processPendingNotifications({ graph: () => deps().graph, relay, now: () => t0 })).toMatchObject({ failed: 1 });
      const failed = await state.db.graphNotification.findFirstOrThrow({ where: { workspaceId: ws } });
      expect(failed).toMatchObject({ status: "FAILED", attempts: 1, lastError: "500 Failure" });
      // The stored error never carries Graph's message (which can hold personal data).
      expect(failed.lastError).not.toContain("@");

      // Not due yet: nothing happens.
      expect(await processPendingNotifications({ graph: () => deps().graph, relay, now: () => t0 })).toMatchObject({ processed: 0, failed: 0 });
      // Later it succeeds.
      const later = new Date(t0.getTime() + 10 * 60_000);
      expect(await processPendingNotifications({ graph: () => deps().graph, relay, now: () => later })).toMatchObject({ processed: 1 });

      // A notification that keeps failing ends as DEAD and flags the calendar for reconciliation.
      await ingestNotifications([{ subscriptionId: sub.graphSubscriptionId, clientState: "secret-state", changeType: "updated", resourceData: { id: ev.id } }]);
      graph.failures.push({ match: /^GET \/me\/events\//, status: 500, sticky: true });
      let at = later;
      for (let i = 0; i < 8; i++) {
        at = new Date(at.getTime() + 600 * 60_000);
        await processPendingNotifications({ graph: () => deps().graph, relay, now: () => at });
      }
      const dead = await state.db.graphNotification.findFirstOrThrow({ where: { workspaceId: ws, status: "DEAD" } });
      expect(dead.attempts).toBe(8);
      expect((await state.db.microsoftConnection.findUniqueOrThrow({ where: { id: connectionId } })).calendarSyncedAt).toBeNull();
    });

    it("treats a deleted or vanished event as cancelled", async () => {
      const sub = await subscribe();
      const ev = graph.addEvent({ start: MON_9, end: MON_10, attendees: [{ emailAddress: { address: "jordan@example.com" } }] });
      await syncCalendar(connectionId, deps().graph, relay);
      graph.events.delete(ev.id);
      await ingestNotifications([{ subscriptionId: sub.graphSubscriptionId, clientState: "secret-state", changeType: "updated", resourceData: { id: ev.id } }]);
      await processPendingNotifications({ graph: () => deps().graph, relay, now: () => new Date() });
      expect((await state.db.meeting.findFirstOrThrow({ where: { workspaceId: ws } })).status).toBe("CANCELLED");
    });

    it("handles lifecycle events: removed subscriptions are recreated and missed ones trigger a sync", async () => {
      const sub = await subscribe();
      graph.addEvent({ start: MON_9, end: MON_10, attendees: [{ emailAddress: { address: "jordan@example.com" } }] });
      await ingestNotifications([
        { subscriptionId: sub.graphSubscriptionId, clientState: "secret-state", lifecycleEvent: "subscriptionRemoved" },
        { subscriptionId: sub.graphSubscriptionId, clientState: "secret-state", lifecycleEvent: "missed" },
      ]);
      await processPendingNotifications({ graph: () => deps().graph, relay, now: () => new Date() });
      const subs = await state.db.graphSubscription.findMany({ where: { connectionId }, orderBy: { createdAt: "asc" } });
      expect(subs.map((s) => s.status)).toEqual(["REMOVED", "ACTIVE"]);
      expect(await state.db.meeting.count({ where: { workspaceId: ws } })).toBe(1);
    });

    it("renews subscriptions, recreates ones Graph lost, and flags revoked consent", async () => {
      const sub = await subscribe();
      expect(await renewSubscription(sub.id, deps().graph)).toBe("renewed");

      graph.subscriptions.clear();
      expect(await renewSubscription(sub.id, deps().graph)).toBe("recreated");

      const live = await state.db.graphSubscription.findFirstOrThrow({ where: { connectionId, status: "ACTIVE" } });
      graph.failures.push({ match: /^PATCH \/subscriptions\//, status: 403, code: "ExtensionError" });
      expect(await renewSubscription(live.id, deps().graph)).toBe("needs_reauth");
      expect((await state.db.microsoftConnection.findUniqueOrThrow({ where: { id: connectionId } })).status).toBe("NEEDS_REAUTH");
    });

    it("restarts a calendar sync when Graph expires the delta token", async () => {
      await state.db.microsoftConnection.update({
        where: { id: connectionId },
        data: { calendarDeltaLink: "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=expired" },
      });
      graph.addEvent({ start: MON_9, end: MON_10, attendees: [{ emailAddress: { address: "jordan@example.com" } }] });
      const counts = await syncCalendar(connectionId, deps().graph, relay);
      expect(counts.created).toBe(1);
      expect((await state.db.microsoftConnection.findUniqueOrThrow({ where: { id: connectionId } })).calendarDeltaLink).toContain("t1");
    });
  });

  describe("notes, transcripts and Carla", () => {
    async function teamsMeeting() {
      relay.addContact({ id: "c1", primaryEmail: "jordan@example.com", displayName: "Jordan Lee", stageKey: "appointment" });
      const ev = graph.addEvent({
        subject: "Estimate review",
        start: MON_9,
        end: MON_10,
        isOnlineMeeting: true,
        onlineMeeting: { joinUrl: "https://teams.example/join/abc" },
        attendees: [{ emailAddress: { address: "jordan@example.com", name: "Jordan Lee" } }],
      });
      await syncCalendar(connectionId, deps().graph, relay);
      return { meeting: await state.db.meeting.findFirstOrThrow({ where: { workspaceId: ws } }), ev };
    }
    const allowTranscripts = () =>
      state.db.microsoftConnection.update({ where: { id: connectionId }, data: { grantedScopes: ["Calendars.ReadWrite", "OnlineMeetingTranscript.Read.All"] } });

    it("links a synced meeting to the one matching lead", async () => {
      const { meeting } = await teamsMeeting();
      expect(meeting.contactId).toBe("c1");
    });

    it("refuses a transcript without consent, without admin-granted scope, or when Microsoft denies access", async () => {
      const { meeting } = await teamsMeeting();
      const user = { kind: "USER" as const, id: "user_a" };
      expect(await importTranscript(ws, meeting.id, user, deps())).toEqual({ ok: false, reason: "NO_CONSENT" });

      await recordConsent({ workspaceId: ws, meetingId: meeting.id, kind: "TRANSCRIPTION", granted: true, method: "VERBAL", participants: ["jordan@example.com"] }, "user_a");
      expect(await importTranscript(ws, meeting.id, user, deps())).toEqual({ ok: false, reason: "SCOPE_NOT_GRANTED" });

      await allowTranscripts();
      expect(await importTranscript(ws, meeting.id, user, deps())).toEqual({ ok: false, reason: "NOT_ORGANIZER" });

      graph.onlineMeetings.set("https://teams.example/join/abc", "om1");
      graph.failures.push({ match: /^GET \/me\/onlineMeetings\/om1\/transcripts/, status: 403, code: "Forbidden" });
      expect(await importTranscript(ws, meeting.id, user, deps())).toEqual({ ok: false, reason: "PERMISSION_DENIED" });

      // Typed notes still work whatever Microsoft says.
      expect((await addNote({ workspaceId: ws, meetingId: meeting.id, body: "Action: send the estimate" }, user)).kind).toBe("MANUAL");
      const reasons = await state.db.meetingEvent.findMany({ where: { meetingId: meeting.id, type: "meeting.transcript_unavailable" } });
      expect(reasons.map((r) => (r.payload as { reason: string }).reason)).toEqual(["NO_CONSENT", "SCOPE_NOT_GRANTED", "NOT_ORGANIZER", "PERMISSION_DENIED"]);
    });

    it("imports a consented Teams transcript once, with speakers, and stops after consent is withdrawn", async () => {
      const { meeting } = await teamsMeeting();
      await allowTranscripts();
      graph.onlineMeetings.set("https://teams.example/join/abc", "om1");
      graph.transcripts.set("om1", [
        {
          id: "tr1",
          createdDateTime: "2026-11-02T17:01:00Z",
          vtt: "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<v Jordan Lee>The furnace is 20 years old.</v>\n\n00:00:04.000 --> 00:00:08.000\n<v Sam Tech>Action: Sam will send the estimate by Friday.</v>\n",
        },
      ]);
      await recordConsent({ workspaceId: ws, meetingId: meeting.id, kind: "TRANSCRIPTION", granted: true, method: "TEAMS_BANNER", participants: [] }, "user_a");
      const user = { kind: "USER" as const, id: "user_a" };
      const first = await importTranscript(ws, meeting.id, user, deps());
      const second = await importTranscript(ws, meeting.id, user, deps());
      expect(first.ok && second.ok && first.noteId === second.noteId).toBe(true);
      const note = await state.db.meetingNote.findFirstOrThrow({ where: { meetingId: meeting.id, kind: "TRANSCRIPT" } });
      expect(note.body).toContain("Jordan Lee: The furnace is 20 years old.");
      expect(note.purgeAfter).not.toBeNull();

      await recordConsent({ workspaceId: ws, meetingId: meeting.id, kind: "TRANSCRIPTION", granted: false, method: "VERBAL", participants: ["jordan@example.com"] }, "user_a");
      expect(await importTranscript(ws, meeting.id, user, deps())).toEqual({ ok: false, reason: "NO_CONSENT" });

      // Retention removes transcripts, never typed notes.
      await addNote({ workspaceId: ws, meetingId: meeting.id, body: "typed" }, user);
      await purgeExpiredTranscripts(new Date(Date.now() + 400 * 86_400_000));
      expect(await state.db.meetingNote.findMany({ where: { meetingId: meeting.id } })).toMatchObject([{ kind: "MANUAL" }]);
    });

    it("protects note edits from silent overwrites", async () => {
      const { meeting } = await teamsMeeting();
      const user = { kind: "USER" as const, id: "user_a" };
      const note = await addNote({ workspaceId: ws, meetingId: meeting.id, body: "v1" }, user);
      await updateNote({ workspaceId: ws, noteId: note.id, body: "v2", expectedVersion: 1 }, user);
      await expect(updateNote({ workspaceId: ws, noteId: note.id, body: "v2b", expectedVersion: 1 }, user)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    });

    it("summarizes, creates linked tasks once, records corrections as feedback, and drafts but never sends a follow-up", async () => {
      const { meeting } = await teamsMeeting();
      const user = { kind: "USER" as const, id: "user_a" };
      await addNote(
        { workspaceId: ws, meetingId: meeting.id, body: "Furnace is 20 years old, heat exchanger cracked.\nDecision: replace rather than repair\nAction: Sam will send the estimate\nTODO: book install date" },
        user
      );
      const summary = await summarizeMeeting(ws, meeting.id, deps());
      expect(summary.producer).toBe("heuristic");
      expect(summary.decisions).toEqual(["replace rather than repair"]);
      expect(summary.actionItems).toMatchObject([{ title: "send the estimate", owner: "Sam" }, { title: "book install date" }]);

      expect(await createActionItemTasks(ws, meeting.id, deps(), "user_a")).toMatchObject({ created: 2 });
      expect(await createActionItemTasks(ws, meeting.id, deps(), "user_a")).toMatchObject({ created: 0, skipped: 2 });
      expect(relay.tasks).toHaveLength(2);
      expect(relay.tasks[0]).toMatchObject({ contactId: "c1", assigneeUserId: "user_a" });
      expect(relay.tasks[0].remindAt).toBeTruthy();

      const corrected = await correctSummary(
        { workspaceId: ws, summaryId: summary.id, summary: "Replace the furnace.", decisions: ["replace"], actionItems: [{ title: "send estimate", owner: "Sam", dueAt: null, relayTaskId: null }], reason: "tighter" },
        "user_a"
      );
      await expect(
        correctSummary({ workspaceId: ws, summaryId: summary.id, summary: "x", decisions: [], actionItems: [], reason: null }, "user_a")
      ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
      const feedback = await state.db.meetingEvent.findFirstOrThrow({ where: { meetingId: meeting.id, type: "feedback.recorded" } });
      expect(feedback.payload).toMatchObject({ targetKind: "MEETING_NOTE", targetId: summary.id, original: { producer: "heuristic" }, corrected: { summary: "Replace the furnace." } });
      // The correction is forwarded to Relay's feedback queue once, with the person as corrector.
      await state.db.meetingEvent.updateMany({ where: { NOT: { id: feedback.id } }, data: { relayPushedAt: new Date() } });
      await pushTimelineOutbox(relay);
      await pushTimelineOutbox(relay);
      expect(relay.feedback).toMatchObject([{ targetKind: "MEETING_NOTE", targetId: summary.id, correctedBy: "user_a", contactId: "c1", idempotencyKey: feedback.id }]);

      // No email conversation in Relay: an Outlook draft, never a send.
      const f = await prepareFollowUp(ws, meeting.id, user, deps());
      expect(f.status).toBe("OUTLOOK_DRAFT");
      expect(graph.drafts[0]).toMatchObject({ to: ["jordan@example.com"] });
      expect(graph.drafts[0].body).toContain("Replace the furnace.");
      expect(graph.count("POST", /\/send$/)).toBe(0);
      // Idempotent per summary.
      expect((await prepareFollowUp(ws, meeting.id, user, deps())).id).toBe(f.id);
      expect(corrected.authorKind).toBe("USER");
    });

    it("sends the follow-up to Relay as a draft when the lead has an email conversation", async () => {
      const { meeting } = await teamsMeeting();
      relay.contacts.get("c1")!.conversations = [{ id: "conv1", channel: "EMAIL", status: "OPEN" }];
      await addNote({ workspaceId: ws, meetingId: meeting.id, body: "Action: confirm the install date" }, { kind: "USER", id: "user_a" });
      await summarizeMeeting(ws, meeting.id, deps());
      const f = await prepareFollowUp(ws, meeting.id, { kind: "AGENT", id: "carla" }, deps());
      expect(f).toMatchObject({ status: "RELAY_DRAFT", relayDraftId: "rdraft1" });
      expect(relay.drafts[0].conversationId).toBe("conv1");
      expect(graph.drafts).toHaveLength(0);
    });

    it("builds a prep brief whose lines trace to evidence", async () => {
      const { meeting } = await teamsMeeting();
      relay.contacts.get("c1")!.tasks = [{ id: "t9", title: "Call back about filters", status: "OPEN" }];
      const brief = await generateBrief(ws, meeting.id, deps());
      expect(brief.producer).toBe("facts");
      expect(brief.body).toContain("Call back about filters");
      expect(brief.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ ref: "aic:task:t9" })]));
    });
  });

  describe("timeline outbox", () => {
    it("holds events until the meeting is linked, pushes each once, and retries failures", async () => {
      // The outbox is global; earlier tests' events are not this test's concern.
      await state.db.meetingEvent.updateMany({ data: { relayPushedAt: new Date() } });
      graph.addEvent({ start: MON_9, end: MON_10, attendees: [{ emailAddress: { address: "stranger@example.com" } }] });
      await syncCalendar(connectionId, deps().graph, relay);
      expect(await pushTimelineOutbox(relay)).toEqual({ pushed: 0, failed: 0 });

      const m = await state.db.meeting.findFirstOrThrow({ where: { workspaceId: ws } });
      await state.db.meeting.update({ where: { id: m.id }, data: { contactId: "c7" } });
      relay.failTimeline = 1;
      expect(await pushTimelineOutbox(relay)).toEqual({ pushed: 0, failed: 1 });
      expect(await pushTimelineOutbox(relay)).toEqual({ pushed: 1, failed: 0 });
      expect(await pushTimelineOutbox(relay)).toEqual({ pushed: 0, failed: 0 });
      expect(relay.timeline).toMatchObject([{ type: "meeting.scheduled", contactId: "c7", payload: { meetingRef: `aic:meeting:${m.id}` } }]);
    });
  });
});

describe("Apollo tool signatures", () => {
  const secret = "s3cret";
  const body = JSON.stringify({ tenantId: "ten_1", agentId: "carla", args: {} });
  const sign = (ts: string, b = body) => `v1=${createHmac("sha256", secret).update(`${ts}.${b}`).digest("hex")}`;
  const now = 1_800_000_000;

  it("accepts a fresh, correctly signed call", () => {
    expect(verifyAicSignature(body, String(now), sign(String(now)), secret, now)).toBe(true);
  });
  it("rejects a tampered body, a wrong secret, a stale timestamp, or no signature", () => {
    expect(verifyAicSignature(body.replace("ten_1", "ten_2"), String(now), sign(String(now)), secret, now)).toBe(false);
    expect(verifyAicSignature(body, String(now), sign(String(now)), "other", now)).toBe(false);
    expect(verifyAicSignature(body, String(now - 301), sign(String(now - 301)), secret, now)).toBe(false);
    expect(verifyAicSignature(body, String(now), null, secret, now)).toBe(false);
  });
});
