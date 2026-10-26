/**
 * Lead operations against a real Postgres: identity resolution under
 * concurrency, takeover, duplicate-send protection, grants and tenant
 * isolation all depend on the database's locks and unique indexes, so no mock
 * can show they hold. Skipped without a database:
 *
 *   TEST_DATABASE_URL=postgresql://postgres@localhost:5432/postgres \
 *     npx vitest run __tests__/leads.db.test.ts
 *
 * Builds the schema from prisma/migrations in a throwaway Postgres schema.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../app/generated/prisma/client";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIR = path.join(__dirname, "..", "prisma", "migrations");

const state = vi.hoisted(() => ({
  db: undefined as unknown as import("../app/generated/prisma/client").PrismaClient,
  user: { userId: "user_a", workspaceId: "ws_a", role: "OWNER" as const },
  counters: new Map<string, number>(),
}));

vi.mock("@/lib/db/client", () => ({
  get prisma() {
    return state.db;
  },
}));
vi.mock("@/lib/workspace-access", () => ({
  hasWorkspaceRole: () => true,
  getCurrentWorkspaceContext: async () => state.user,
}));
vi.mock("@/lib/queue/client", () => ({
  getRedisConnection: () => ({
    incr: async (k: string) => {
      const n = (state.counters.get(k) ?? 0) + 1;
      state.counters.set(k, n);
      return n;
    },
    expire: async () => 1,
  }),
}));
vi.mock("@/lib/leads/queue", () => ({ enqueueCarla: vi.fn(async () => {}) }));

import { ingestInbound, type InboundEvent } from "../lib/leads/ingest";
import { proposeDraft, sendAsUser, sendDraftWithGrant } from "../lib/leads/drafts";
import { acquireLock, addInternal, getConversation, takeOver, setMode } from "../lib/leads/conversations";
import { registerSender, type SendOutcome } from "../lib/leads/senders";
import { mintSendGrant, sha256Hex } from "../lib/leads/grant";
import { mergeContacts, updateContact, writeExternalEvent, listChanges, updateOpportunity } from "../lib/leads/records";
import { rulesBrain, runCarla } from "../lib/leads/carla";
import { recordFeedback } from "../lib/leads/feedback";
import { mintApiKey } from "../lib/leads/keys";
import { toInboundEvent } from "../lib/leads/forms";
import { LeadError } from "../lib/leads/errors";
import { POST as eventsPOST } from "../app/api/relay/v1/events/route";
import { POST as sendPOST } from "../app/api/relay/v1/drafts/[id]/send/route";
import { GET as conversationGET } from "../app/api/relay/v1/conversations/[id]/route";
import { POST as formPOST } from "../app/api/forms/[key]/route";
import { POST as actionsPOST } from "../app/api/leads/conversations/[id]/actions/route";
import { POST as feedbackPOST } from "../app/api/relay/v1/feedback/route";
import { POST as draftsPOST } from "../app/api/relay/v1/conversations/[id]/drafts/route";
import { getContactProfile } from "../lib/leads/records";
import { outlookEmailSender } from "../lib/leads/outlook-sender";
import { GraphError, type GraphClient } from "../lib/microsoft/graph";

const SECRET = "test-grant-secret-0123456789abcdefghij";
const schema = `leads_${randomBytes(4).toString("hex")}`;
let sql: Client;

const A = { kind: "SYSTEM" as const, id: "test", workspaceId: "ws_a" };
const B = { kind: "SYSTEM" as const, id: "test", workspaceId: "ws_b" };
const CARLA_A = { kind: "AGENT" as const, id: "carla", workspaceId: "ws_a" };
const USER_A = { kind: "USER" as const, id: "user_a", workspaceId: "ws_a" };
const USER_A2 = { kind: "USER" as const, id: "user_a2", workspaceId: "ws_a" };
const SERVICE_A = { kind: "SERVICE" as const, id: "key:apollo", workspaceId: "ws_a" };

// A fake email channel whose outcome each test controls.
const sent: { body: string; idempotencyKey: string }[] = [];
let nextOutcome: SendOutcome = { status: "sent", externalMessageId: null };
let sendDelayMs = 0;

function email(over: Partial<InboundEvent> = {}, from = "jordan@example.com"): InboundEvent {
  const id = randomUUID();
  return {
    channel: "EMAIL",
    channelAccountRef: "service@aic.test",
    externalThreadId: `thread-${id}`,
    externalMessageId: `<${id}@mail.test>`,
    occurredAt: new Date(),
    from: { displayName: "Jordan Lee", identities: [{ kind: "EMAIL", value: from }] },
    subject: "Furnace",
    body: "Our furnace stopped working last night, can someone come by?",
    kind: "MESSAGE",
    attachments: [],
    ...over,
  };
}

async function draftFor(conversationId: string, body = "Hi Jordan, we can help. What times work for you?") {
  return proposeDraft(CARLA_A, conversationId, { body });
}

function grantFor(draft: { id: string; body: string }, approvalId = `apr_${randomBytes(8).toString("hex")}`, workspaceId = "ws_a") {
  return mintSendGrant(SECRET, { approvalId, workspaceId, draftId: draft.id, textSha256: sha256Hex(draft.body), approvedBy: "usr_e" });
}

async function code(p: Promise<unknown>) {
  try {
    await p;
    return "OK";
  } catch (err) {
    if (err instanceof LeadError) return err.code;
    throw err;
  }
}

function req(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(url, {
    method,
    headers: { "content-type": "application/json", origin: "http://localhost", host: "localhost", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe.skipIf(!DATABASE_URL)("lead operations on Postgres", () => {
  beforeAll(async () => {
    process.env.RELAY_GRANT_SECRET = SECRET;
    process.env.LEADS_EMAIL_SERVER = "smtp://unused";
    process.env.LEADS_EMAIL_FROM = "AIC OS <carla@aic.test>";
    sql = new Client({ connectionString: DATABASE_URL });
    await sql.connect();
    await sql.query(`CREATE SCHEMA "${schema}"`);
    await sql.query(`SET search_path TO "${schema}"`);
    const dirs = readdirSync(MIGRATIONS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    for (const dir of dirs) await sql.query(readFileSync(path.join(MIGRATIONS_DIR, dir, "migration.sql"), "utf8"));
    await sql.query(`
      INSERT INTO "User" ("id", "email", "updatedAt") VALUES ('user_a', 'a@test.dev', now()), ('user_a2', 'a2@test.dev', now()), ('user_b', 'b@test.dev', now());
      INSERT INTO "Workspace" ("id", "name", "ownerId", "updatedAt") VALUES ('ws_a', 'AIC', 'user_a', now()), ('ws_b', 'Other', 'user_b', now());
      INSERT INTO "WorkspaceMember" ("id", "workspaceId", "userId", "role") VALUES ('m1', 'ws_a', 'user_a', 'OWNER'), ('m2', 'ws_a', 'user_a2', 'MEMBER'), ('m3', 'ws_b', 'user_b', 'OWNER');
      INSERT INTO "KnowledgeEntry" ("id", "workspaceId", "key", "title", "body", "updatedAt")
        VALUES ('k1', 'ws_a', 'booking', 'Booking', 'Reply with two or three times that suit you and we will confirm one.', now());
    `);
    const url = new URL(DATABASE_URL!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    state.db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString(), max: 12 }, { schema }) });

    const smtpStandIn = {
      unavailableReason: async () => null,
      send: async (r: { body: string; idempotencyKey: string }) => {
        if (sendDelayMs) await new Promise((res) => setTimeout(res, sendDelayMs));
        sent.push({ body: r.body, idempotencyKey: r.idempotencyKey });
        return nextOutcome;
      },
    };
    registerSender("EMAIL", smtpStandIn);
    registerSender("WEB_FORM", smtpStandIn);
  });

  afterAll(async () => {
    await state.db?.$disconnect();
    if (sql) {
      await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await sql.end();
    }
  });

  beforeEach(() => {
    sent.length = 0;
    nextOutcome = { status: "sent", externalMessageId: null };
    sendDelayMs = 0;
    state.user = { userId: "user_a", workspaceId: "ws_a", role: "OWNER" };
  });

  // ── Lead capture ─────────────────────────────────────────────────────────

  it("creates one lead with a timeline, and a replayed event changes nothing", async () => {
    const ev = email({}, "capture@example.com");
    const first = await ingestInbound(A, ev);
    expect(first).toMatchObject({ duplicate: false, contactCreated: true });
    const again = await ingestInbound(A, ev);
    expect(again).toMatchObject({ duplicate: true, contactId: first.contactId, messageId: first.messageId });

    expect(await state.db.message.count({ where: { conversationId: first.conversationId } })).toBe(1);
    const opp = await state.db.opportunity.findFirstOrThrow({ where: { contactId: first.contactId } });
    expect(opp.stageKey).toBe("new");
    const types = (await state.db.timelineEvent.findMany({ where: { contactId: first.contactId }, orderBy: { seq: "asc" } })).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["contact.created", "opportunity.created", "identity.linked", "conversation.created", "message.received"]));
  });

  it("matches the same person across channels and formats into one contact", async () => {
    const mail = await ingestInbound(A, email({ from: { displayName: "Sam Ortiz", identities: [{ kind: "EMAIL", value: "Sam.Ortiz@Example.com" }, { kind: "PHONE", value: "(403) 555-0111" }] } }));
    const sms = await ingestInbound(A, {
      ...email(), channel: "SMS", channelAccountRef: "+14035550000", externalThreadId: "+14035550111",
      from: { identities: [{ kind: "PHONE", value: "+1 403 555 0111" }] }, body: "Also the AC is noisy",
    });
    expect(sms.contactId).toBe(mail.contactId);
    expect(sms.contactCreated).toBe(false);
    expect(await state.db.contact.count({ where: { workspaceId: "ws_a", primaryPhone: "+14035550111" } })).toBe(1);
  });

  it("creates exactly one contact when ten messages from a new person arrive at once", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => ingestInbound(A, email({}, "burst@example.com"))));
    expect(new Set(results.map((r) => r.contactId)).size).toBe(1);
    expect(results.filter((r) => r.contactCreated)).toHaveLength(1);
    expect(await state.db.contactIdentity.count({ where: { workspaceId: "ws_a", value: "burst@example.com" } })).toBe(1);
  });

  it("flags two records that share an identity, and merging keeps every conversation", async () => {
    const one = await ingestInbound(A, email({}, "dup-one@example.com"));
    const two = await ingestInbound(A, { ...email(), channel: "SMS", externalThreadId: "+14035550199", from: { identities: [{ kind: "PHONE", value: "4035550199" }] } });
    expect(two.contactId).not.toBe(one.contactId);
    const both = await ingestInbound(A, email({ from: { identities: [{ kind: "EMAIL", value: "dup-one@example.com" }, { kind: "PHONE", value: "4035550199" }] } }));
    expect(both.duplicateCandidates).toEqual([two.contactId]);
    expect(await state.db.duplicateCandidate.count({ where: { status: "OPEN", OR: [{ contactId: one.contactId }, { otherContactId: one.contactId }] } })).toBe(1);

    await mergeContacts(USER_A, one.contactId, two.contactId);
    expect(await state.db.conversation.count({ where: { contactId: one.contactId } })).toBe(3);
    const later = await ingestInbound(A, { ...email(), channel: "SMS", externalThreadId: "+14035550199", from: { identities: [{ kind: "PHONE", value: "4035550199" }] }, body: "hello again" });
    expect(later.contactId).toBe(one.contactId);
  });

  it("turns a website form into a lead with recorded consent", async () => {
    const form = toInboundEvent({ name: "Riley Chen", email: "riley@example.com", phone: "403-555-0123", message: "Quote for a new furnace please", consent: "on", page: "https://aic.test/contact" }, "website");
    const r = await ingestInbound(A, form);
    const consent = await state.db.consent.findFirstOrThrow({ where: { contactId: r.contactId } });
    expect(consent).toMatchObject({ channel: "EMAIL", basis: "EXPRESS", status: "GRANTED" });
    expect((await ingestInbound(A, form)).duplicate).toBe(true);
  });

  it("serves the public form endpoint, drops honeypot posts and refuses non-form keys", async () => {
    const formKey = await mintApiKey("ws_a", "website", ["forms:submit"]);
    const ok = await formPOST(
      req("POST", `http://localhost/api/forms/${formKey.secret}`, "name=Ava&email=ava%40example.com&message=Need+AC+service", { "content-type": "application/x-www-form-urlencoded" }),
      { params: Promise.resolve({ key: formKey.secret }) }
    );
    expect(ok.status).toBe(201);
    expect(await state.db.contactIdentity.count({ where: { value: "ava@example.com" } })).toBe(1);
    const bot = await formPOST(req("POST", `http://localhost/api/forms/${formKey.secret}`, { name: "x", email: "bot@example.com", website: "http://spam" }), { params: Promise.resolve({ key: formKey.secret }) });
    expect(bot.status).toBe(201);
    expect(await state.db.contactIdentity.count({ where: { value: "bot@example.com" } })).toBe(0);
    const serviceKey = await mintApiKey("ws_a", "apollo-read", ["inbox:read"]);
    const wrong = await formPOST(req("POST", `http://localhost/api/forms/${serviceKey.secret}`, { email: "x@example.com" }), { params: Promise.resolve({ key: serviceKey.secret }) });
    expect(wrong.status).toBe(404);
  });

  // ── Sends: approval, duplicates, takeover ────────────────────────────────

  it("sends an approved draft once, whatever is replayed", async () => {
    const lead = await ingestInbound(A, email({}, "send-once@example.com"));
    const draft = await draftFor(lead.conversationId);
    const grant = grantFor(draft, "apr_once");
    const results = await Promise.all([sendDraftWithGrant(SERVICE_A, draft.id, grant), sendDraftWithGrant(SERVICE_A, draft.id, grant).catch((e) => e)]);
    expect(sent).toHaveLength(1);
    expect(results.some((r) => r.status === "SENT" && r.replay === false)).toBe(true);
    const replay = await sendDraftWithGrant(SERVICE_A, draft.id, grant);
    expect(replay).toMatchObject({ status: "SENT", replay: true });
    expect(await code(sendDraftWithGrant(SERVICE_A, draft.id, grantFor(draft, "apr_other")))).toBe("APPROVAL_ALREADY_USED");
    expect(sent).toHaveLength(1);
    const outbound = await state.db.message.findMany({ where: { conversationId: lead.conversationId, direction: "OUTBOUND" } });
    expect(outbound).toHaveLength(1);
  });

  it("refuses grants for other text, other drafts, other workspaces and expired grants", async () => {
    const lead = await ingestInbound(A, email({}, "grants@example.com"));
    const draft = await draftFor(lead.conversationId);
    const other = await proposeDraft(USER_A, lead.conversationId, { body: "a different reply" });
    expect(await code(sendDraftWithGrant(SERVICE_A, draft.id, grantFor({ id: draft.id, body: "edited after approval" })))).toBe("GRANT_TEXT_MISMATCH");
    expect(await code(sendDraftWithGrant(SERVICE_A, draft.id, grantFor(other)))).toBe("GRANT_WRONG_DRAFT");
    expect(await code(sendDraftWithGrant(B, draft.id, grantFor(draft, undefined, "ws_b")))).toBe("NOT_FOUND");
    expect(await code(sendDraftWithGrant(SERVICE_A, draft.id, grantFor(draft, undefined, "ws_b")))).toBe("GRANT_WRONG_WORKSPACE");
    const expired = mintSendGrant(SECRET, { approvalId: "apr_old", workspaceId: "ws_a", draftId: draft.id, textSha256: draft.bodySha256, approvedBy: "u" }, 60, Date.now() - 120_000);
    expect(await code(sendDraftWithGrant(SERVICE_A, draft.id, expired))).toBe("GRANT_EXPIRED");
    expect(sent).toHaveLength(0);
  });

  it("stops AIC OS when a person takes over, and lets the person reply", async () => {
    const lead = await ingestInbound(A, email({}, "takeover@example.com"));
    const draft = await draftFor(lead.conversationId);
    await takeOver(USER_A, lead.conversationId);
    expect((await state.db.draft.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("DISCARDED");
    expect(await code(sendDraftWithGrant(SERVICE_A, draft.id, grantFor(draft)))).toBe("DRAFT_DISCARDED");
    expect(await code(draftFor(lead.conversationId))).toBe("CARLA_PAUSED");
    const r = await sendAsUser(USER_A, lead.conversationId, { body: "Hi, this is Dana from AIC. I can come by at 3.", idempotencyKey: randomUUID(), basedOnMessageId: lead.messageId });
    expect(r.status).toBe("SENT");
    await setMode(USER_A, lead.conversationId, "SUPERVISED");
    expect((await draftFor(lead.conversationId)).status).toBe("PROPOSED");
    expect(sent).toHaveLength(1);
  });

  it("marks a draft stale when the customer writes again before it is sent", async () => {
    const lead = await ingestInbound(A, email({}, "stale@example.com"));
    const draft = await draftFor(lead.conversationId);
    await ingestInbound(A, { ...email({}, "stale@example.com"), externalThreadId: (await state.db.conversation.findUniqueOrThrow({ where: { id: lead.conversationId } })).externalThreadId, body: "Actually it started again" });
    expect((await state.db.draft.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("STALE");
    expect(await code(sendDraftWithGrant(SERVICE_A, draft.id, grantFor(draft)))).toBe("DRAFT_STALE");
    expect(sent).toHaveLength(0);
  });

  it("sends a double-clicked reply once, and two people answering at once send once", async () => {
    const lead = await ingestInbound(A, email({}, "double@example.com"));
    sendDelayMs = 50;
    const key = randomUUID();
    const clicks = await Promise.allSettled([
      sendAsUser(USER_A, lead.conversationId, { body: "On our way", idempotencyKey: key, basedOnMessageId: lead.messageId }),
      sendAsUser(USER_A, lead.conversationId, { body: "On our way", idempotencyKey: key, basedOnMessageId: lead.messageId }),
    ]);
    expect(clicks.filter((c) => c.status === "fulfilled")).not.toHaveLength(0);
    expect(sent).toHaveLength(1);

    const lead2 = await ingestInbound(A, email({}, "collide@example.com"));
    const race = await Promise.allSettled([
      sendAsUser(USER_A, lead2.conversationId, { body: "Reply one", idempotencyKey: randomUUID(), basedOnMessageId: lead2.messageId }),
      sendAsUser(USER_A2, lead2.conversationId, { body: "Reply two", idempotencyKey: randomUUID(), basedOnMessageId: lead2.messageId }),
    ]);
    expect(race.filter((r) => r.status === "fulfilled" && r.value.status === "SENT")).toHaveLength(1);
    const refused = race.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(["DRAFT_STALE", "SEND_IN_PROGRESS"]).toContain((refused.reason as LeadError).code);
    expect(sent).toHaveLength(2);
  });

  it("withdraws drafts on the person's other channels once one reply goes out", async () => {
    const mail = await ingestInbound(A, email({}, "two-channels@example.com"));
    const form = await ingestInbound(A, { ...email({}, "two-channels@example.com"), channel: "WEB_FORM", externalThreadId: "form:two", externalMessageId: "form:two" });
    expect(form.contactId).toBe(mail.contactId);
    const formDraft = await draftFor(form.conversationId);
    await sendAsUser(USER_A, mail.conversationId, { body: "Answered by email", idempotencyKey: randomUUID(), basedOnMessageId: mail.messageId });
    expect((await state.db.draft.findUniqueOrThrow({ where: { id: formDraft.id } })).status).toBe("STALE");
    expect(await code(sendDraftWithGrant(SERVICE_A, formDraft.id, grantFor(formDraft)))).toBe("DRAFT_STALE");
    expect(sent).toHaveLength(1);
  });

  it("refuses a send while someone else holds the compose lock", async () => {
    const lead = await ingestInbound(A, email({}, "lock@example.com"));
    expect((await acquireLock(USER_A, lead.conversationId)).held).toBe(true);
    expect((await acquireLock(USER_A2, lead.conversationId)).held).toBe(false);
    expect(await code(sendAsUser(USER_A2, lead.conversationId, { body: "me too", idempotencyKey: randomUUID(), basedOnMessageId: lead.messageId }))).toBe("LOCKED");
    expect(sent).toHaveLength(0);
  });

  it("honours an opt-out and never retries an unconfirmed send", async () => {
    const lead = await ingestInbound(A, email({}, "optout@example.com"));
    const thread = (await state.db.conversation.findUniqueOrThrow({ where: { id: lead.conversationId } })).externalThreadId;
    const stop = await ingestInbound(A, { ...email({}, "optout@example.com"), externalThreadId: thread, body: "STOP" });
    expect(await code(sendAsUser(USER_A, lead.conversationId, { body: "One more thing", idempotencyKey: randomUUID(), basedOnMessageId: stop.messageId }))).toBe("CONSENT_WITHDRAWN");

    const lead2 = await ingestInbound(A, email({}, "unconfirmed@example.com"));
    nextOutcome = { status: "unconfirmed", error: "socket hang up" };
    const draft = await draftFor(lead2.conversationId);
    const grant = grantFor(draft);
    expect((await sendDraftWithGrant(SERVICE_A, draft.id, grant)).status).toBe("SEND_UNCONFIRMED");
    expect((await sendDraftWithGrant(SERVICE_A, draft.id, grant)).replay).toBe(true);
    expect(sent).toHaveLength(1);
  });

  // ── AIC OS ────────────────────────────────────────────────────────────────

  it("classifies, scores, drafts from approved facts and creates follow-ups", async () => {
    const lead = await ingestInbound(A, email({ from: { displayName: "Morgan Hill", firstName: "Morgan", identities: [{ kind: "EMAIL", value: "morgan@example.com" }, { kind: "PHONE", value: "4035550144" }] } }));
    const r = await runCarla("ws_a", lead.conversationId, rulesBrain);
    expect(r.handoff).toBe(false);
    const assessment = await state.db.assessment.findUniqueOrThrow({ where: { id: r.assessmentId } });
    expect(assessment).toMatchObject({ intent: "emergency_service", urgency: "HIGH" });
    const draft = await state.db.draft.findUniqueOrThrow({ where: { id: r.draftId! } });
    expect(draft.body).toContain("Hi Morgan");
    expect(draft.body).toContain("two or three times");
    expect(draft.status).toBe("PROPOSED");
    expect(r.tasksCreated).toBeGreaterThan(0);
    expect((await state.db.contact.findUniqueOrThrow({ where: { id: lead.contactId } })).stageKey).toBe("qualifying");
    expect(sent).toHaveLength(0);
  });

  it("hands a safety emergency to a person without drafting", async () => {
    const lead = await ingestInbound(A, email({ body: "There is a gas smell near the furnace" }, "gas@example.com"));
    const r = await runCarla("ws_a", lead.conversationId, rulesBrain);
    expect(r).toMatchObject({ handoff: true, draftId: null });
    expect((await state.db.conversation.findUniqueOrThrow({ where: { id: lead.conversationId } })).mode).toBe("HUMAN");
    expect(await state.db.task.count({ where: { conversationId: lead.conversationId, priority: "URGENT" } })).toBeGreaterThan(0);
  });

  it("uses private coaching as context and never shows it to the customer", async () => {
    const lead = await ingestInbound(A, email({}, "coach@example.com"));
    await addInternal(USER_A, lead.conversationId, "COACHING", "Offer the Thursday slot first.");
    let seen: string[] = [];
    await runCarla("ws_a", lead.conversationId, {
      id: "spy",
      assess: async (ctx) => {
        seen = ctx.messages.filter((m) => m.direction === "INTERNAL").map((m) => m.body);
        return rulesBrain.assess(ctx);
      },
    });
    expect(seen).toEqual(["Offer the Thursday slot first."]);
    expect(await state.db.message.count({ where: { conversationId: lead.conversationId, direction: "OUTBOUND" } })).toBe(0);
  });

  it("falls back to the rules when the model answer is malformed", async () => {
    const lead = await ingestInbound(A, email({}, "fallback@example.com"));
    const r = await runCarla("ws_a", lead.conversationId, { id: "broken-model", assess: async () => { throw new Error("bad json"); } });
    expect(r.producer).toBe("rules-v1 (fallback from broken-model)");
  });

  it("records a correction and shows the corrected view", async () => {
    const lead = await ingestInbound(A, email({ body: "How much for a new heat pump?" }, "correct@example.com"));
    const r = await runCarla("ws_a", lead.conversationId, rulesBrain);
    await recordFeedback(USER_A, { targetKind: "ASSESSMENT", targetId: r.assessmentId, corrected: { urgency: "LOW", leadScore: 90 }, reason: "Planning for spring" });
    const current = await state.db.assessment.findFirstOrThrow({ where: { conversationId: lead.conversationId, supersededAt: null } });
    expect(current).toMatchObject({ urgency: "LOW", leadScore: 90, producer: "human:user_a" });
    expect(await state.db.feedback.count({ where: { targetId: r.assessmentId, status: "NEW" } })).toBe(1);
  });

  it("takes forwarded corrections and retried proposals from other modules once", async () => {
    const lead = await ingestInbound(A, email({}, "meetings@example.com"));
    await runCarla("ws_a", lead.conversationId, rulesBrain);
    const fbKey = await mintApiKey("ws_a", "meetings", ["feedback:write"]);
    const auth = { authorization: `Bearer ${fbKey.secret}`, "idempotency-key": "meeting-note-1-fix" };
    const note = { targetKind: "MEETING_NOTE", targetId: "note_1", contactId: lead.contactId, original: { text: "AC" }, corrected: { text: "Heat pump" }, correctedBy: "user_a2" };
    const first = await feedbackPOST(req("POST", "http://localhost/api/relay/v1/feedback", note, auth), undefined as never);
    const again = await feedbackPOST(req("POST", "http://localhost/api/relay/v1/feedback", note, auth), undefined as never);
    expect(first.status).toBe(201);
    expect((await again.json()).feedbackId).toBe((await first.json()).feedbackId);
    expect(await state.db.feedback.count({ where: { targetId: "note_1", userId: "user_a2" } })).toBe(1);
    const stranger = await feedbackPOST(req("POST", "http://localhost/api/relay/v1/feedback", { ...note, correctedBy: "user_b" }, { authorization: auth.authorization }), undefined as never);
    expect(stranger.status).toBe(404);

    const assistKey = await mintApiKey("ws_a", "meetings-assist", ["assist:write"]);
    const propose = () => draftsPOST(
      req("POST", `http://localhost/api/relay/v1/conversations/${lead.conversationId}/drafts`, { body: "Following up on our visit." }, { authorization: `Bearer ${assistKey.secret}`, "x-agent-id": "meetings", "idempotency-key": "followup-visit-1" }),
      { params: Promise.resolve({ id: lead.conversationId }) },
    );
    const d1 = await (await propose()).json();
    const d2 = await (await propose()).json();
    expect(d2.draftId).toBe(d1.draftId);
    expect(await state.db.draft.count({ where: { conversationId: lead.conversationId, authorId: "meetings" } })).toBe(1);

    const profile = await getContactProfile(A, lead.contactId);
    expect(profile.latestAssessment?.conversationId).toBe(lead.conversationId);
  });

  it("sends approved email from the connected Outlook mailbox and reports what Graph did", async () => {
    await sql.query(`
      INSERT INTO "MicrosoftConnection" ("id", "workspaceId", "userId", "msTenantId", "msUserId", "email", "grantedScopes", "accessTokenEnc", "accessExpiresAt", "refreshTokenEnc", "updatedAt")
      VALUES ('mc1', 'ws_a', 'user_a', 't', 'u', 'service@aic.test', ARRAY['Mail.Send'], 'x', now(), 'x', now())
    `);
    const lead = await ingestInbound(A, email({}, "outlook@example.com"));
    const inbound = await state.db.message.findFirstOrThrow({ where: { conversationId: lead.conversationId } });
    const calls: string[] = [];
    let sendError: unknown = null;
    const graph = {
      async request(path: string, init: RequestInit = {}) {
        calls.push(`${init.method ?? "GET"} ${path.split("?")[0]}`);
        if (path.startsWith("/me/messages?")) return { value: [{ id: "orig1" }] };
        if (path.endsWith("/createReply")) return { id: "draft1", internetMessageId: "<draft1@aic.test>" };
        return {};
      },
      async sendDraft(id: string) {
        calls.push(`SEND ${id}`);
        if (sendError) throw sendError;
        return {};
      },
    } as unknown as GraphClient;
    const sender = outlookEmailSender(() => graph);
    const req = {
      workspaceId: "ws_a", channel: "EMAIL" as const, channelAccountRef: "service@aic.test", conversationId: lead.conversationId,
      contactId: lead.contactId, subject: "Furnace", body: "We can come Tuesday.", inReplyTo: inbound.externalMessageId, idempotencyKey: "d1",
    };

    expect(await sender.unavailableReason(req)).toBeNull();
    expect(await sender.unavailableReason({ ...req, channelAccountRef: "other@aic.test" })).toBe("OUTLOOK_NOT_CONNECTED");
    expect(await sender.send(req)).toEqual({ status: "sent", externalMessageId: "<draft1@aic.test>" });
    expect(calls).toEqual(["GET /me/messages", "POST /me/messages/orig1/createReply", "SEND draft1"]);

    sendError = new GraphError(403, "ErrorAccessDenied", "/me/messages/…/send");
    calls.length = 0;
    expect((await sender.send(req)).status).toBe("rejected");
    expect(calls).toContain("DELETE /me/messages/draft1");

    sendError = new GraphError(504, "GatewayTimeout", "/me/messages/…/send");
    expect((await sender.send(req)).status).toBe("unconfirmed");
  });

  // ── Records, history and isolation ───────────────────────────────────────

  it("protects against lost updates and tracks stage outcomes", async () => {
    const lead = await ingestInbound(A, email({}, "version@example.com"));
    const c = await state.db.contact.findUniqueOrThrow({ where: { id: lead.contactId } });
    await updateContact(USER_A, c.id, { version: c.version, company: "Hill Homes" });
    expect(await code(updateContact(USER_A2, c.id, { version: c.version, company: "Other" }))).toBe("VERSION_CONFLICT");
    const opp = await state.db.opportunity.findFirstOrThrow({ where: { contactId: c.id } });
    const won = await updateOpportunity(USER_A, opp.id, { version: opp.version, stageKey: "won", valueCents: 850000 });
    expect(won).toMatchObject({ outcome: "WON", valueCents: 850000 });
    expect(await state.db.timelineEvent.count({ where: { opportunityId: opp.id, type: "opportunity.won" } })).toBe(1);
  });

  it("dedupes timeline events from other modules and serves an ordered change feed", async () => {
    const lead = await ingestInbound(A, email({}, "meeting@example.com"));
    const ev = { type: "meeting.completed", contactId: lead.contactId, idempotencyKey: "graph-evt-1", payload: { title: "Estimate visit" } };
    const one = await writeExternalEvent(SERVICE_A, ev);
    expect(await writeExternalEvent(SERVICE_A, ev)).toEqual({ id: one.id, duplicate: true });
    const byPhone = await writeExternalEvent(SERVICE_A, { type: "call.completed", externalId: "rc-1", contact: { identities: [{ kind: "EMAIL", value: "MEETING@example.com" }] } });
    expect(byPhone.duplicate).toBe(false);
    expect(await code(writeExternalEvent(SERVICE_A, { type: "call.completed", contact: { identities: [{ kind: "PHONE", value: "4035559999" }] } }))).toBe("CONTACT_NOT_FOUND");
    await sql.query(`UPDATE "${schema}"."TimelineEvent" SET "createdAt" = now() - interval '1 minute'`);
    const feed = await listChanges(A, BigInt(0), 500);
    const seqs = feed.events.map((e) => BigInt(e.seq));
    expect(seqs).toEqual([...seqs].sort((a, b) => (a < b ? -1 : 1)));
    expect(feed.events.every((e) => e.workspaceId === "ws_a")).toBe(true);
  });

  it("keeps workspaces apart: same person, separate records, no cross reads or writes", async () => {
    const a = await ingestInbound(A, email({}, "shared@example.com"));
    const b = await ingestInbound(B, email({}, "shared@example.com"));
    expect(b.contactId).not.toBe(a.contactId);
    expect(await code(getConversation(B, a.conversationId))).toBe("NOT_FOUND");
    expect(await code(proposeDraft({ ...CARLA_A, workspaceId: "ws_b" }, a.conversationId, { body: "x" }))).toBe("NOT_FOUND");
    expect(await code(takeOver({ ...USER_A, workspaceId: "ws_b" }, a.conversationId))).toBe("NOT_FOUND");
    expect(await code(writeExternalEvent(B, { type: "meeting.completed", contactId: a.contactId }))).toBe("INVALID_LINK");
  });

  // ── HTTP surface ─────────────────────────────────────────────────────────

  it("authenticates service keys, enforces scopes and takes the workspace from the key", async () => {
    const ingestKey = await mintApiKey("ws_a", "outlook", ["events:ingest"]);
    const bKey = await mintApiKey("ws_b", "reader-b", ["inbox:read"]);
    const body = email({}, "http@example.com");
    expect((await eventsPOST(req("POST", "http://localhost/api/relay/v1/events", body), undefined as never)).status).toBe(401);
    expect((await eventsPOST(req("POST", "http://localhost/api/relay/v1/events", body, { authorization: `Bearer ${bKey.secret}` }), undefined as never)).status).toBe(403);
    const created = await eventsPOST(req("POST", "http://localhost/api/relay/v1/events", body, { authorization: `Bearer ${ingestKey.secret}` }), undefined as never);
    expect(created.status).toBe(201);
    const { conversationId } = await created.json();
    const crossRead = await conversationGET(req("GET", `http://localhost/api/relay/v1/conversations/${conversationId}`, undefined, { authorization: `Bearer ${bKey.secret}` }), { params: Promise.resolve({ id: conversationId }) });
    expect(crossRead.status).toBe(404);
    await state.db.relayApiKey.update({ where: { id: ingestKey.id }, data: { revokedAt: new Date() } });
    expect((await eventsPOST(req("POST", "http://localhost/api/relay/v1/events", email(), { authorization: `Bearer ${ingestKey.secret}` }), undefined as never)).status).toBe(401);
  });

  it("answers Apollo's send call with the agreed status codes", async () => {
    const sendKey = await mintApiKey("ws_a", "apollo", ["messages:send"]);
    const lead = await ingestInbound(A, email({}, "apollo@example.com"));
    const draft = await draftFor(lead.conversationId);
    const call = (grant: string) =>
      sendPOST(req("POST", `http://localhost/api/relay/v1/drafts/${draft.id}/send`, { workspaceId: "ws_a" }, { authorization: `Bearer ${sendKey.secret}`, "x-relay-grant": grant, "idempotency-key": "apr_http" }), { params: Promise.resolve({ id: draft.id }) });
    const grant = grantFor(draft, "apr_http");
    const ok = await call(grant);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ status: "SENT" });
    expect((await call(grant)).status).toBe(200);
    expect((await call(grantFor(draft, "apr_second"))).status).toBe(409);
    expect((await call("garbage.token")).status).toBe(403);
    expect(sent).toHaveLength(1);
  });

  it("rejects cross-site writes to the inbox API", async () => {
    const lead = await ingestInbound(A, email({}, "csrf@example.com"));
    const res = await actionsPOST(
      req("POST", `http://localhost/api/leads/conversations/${lead.conversationId}/actions`, { action: "takeover" }, { origin: "https://evil.example" }),
      { params: Promise.resolve({ id: lead.conversationId }) }
    );
    expect(res.status).toBe(403);
    expect((await state.db.conversation.findUniqueOrThrow({ where: { id: lead.conversationId } })).mode).toBe("SUPERVISED");
  });
});
