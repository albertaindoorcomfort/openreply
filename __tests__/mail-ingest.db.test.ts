/**
 * Inbound Outlook mail for the lead inbox, against a real Postgres, with
 * Microsoft Graph and Relay faked at their HTTP/API boundary. Skipped without
 * a database:
 *
 *   TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:55432/postgres \
 *     npx vitest run __tests__/mail-ingest.db.test.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../app/generated/prisma/client";
import { FakeGraph, FakeRelay } from "./helpers/meetings-fakes";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.ENCRYPTION_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.AIC_INTERNAL_DOMAINS = "aic.example";
process.env.LEADS_OUTLOOK_MAILBOX = "Service@aic.example";
process.env.NEXTAUTH_URL = "https://app.aic.example";

const state = vi.hoisted(() => ({
  db: undefined as unknown as import("../app/generated/prisma/client").PrismaClient,
  context: null as null | { workspaceId: string; userId: string },
  graph: undefined as unknown as import("../lib/microsoft/graph").GraphClient,
}));
vi.mock("@/lib/db/client", () => ({
  get prisma() {
    return state.db;
  },
}));
vi.mock("@/lib/workspace-access", () => ({ getCurrentWorkspaceContext: async () => state.context }));
vi.mock("@/lib/microsoft/connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/microsoft/connection")>()),
  getGraphClientForConnection: () => state.graph,
}));

import { encryptToken } from "../lib/meta/oauth";
import { GraphClient } from "../lib/microsoft/graph";
import { hashClientState, MAIL_RESOURCE, renewSubscription } from "../lib/microsoft/subscriptions";
import { ingestNotifications, processPendingNotifications } from "../lib/microsoft/notifications";
import { processMessage, retryFailedMail, startMailIngest, syncInbox } from "../lib/microsoft/mail";
import { GET as getAttachment } from "../app/api/microsoft/mail/attachments/[connectionId]/[messageId]/[attachmentId]/route";

const MIGRATIONS_DIR = path.join(__dirname, "..", "prisma", "migrations");
const schema = `mail_${randomBytes(4).toString("hex")}`;
let sql: Client;

let graph: FakeGraph;
let relay: FakeRelay;
let ws = "";
let connectionId = "";

const client = () => new GraphClient({ get: async () => "token" }, graph.fetch, async () => undefined);
const deps = (now = new Date()) => ({ graph: client(), relay, now: () => now });
const connection = () => state.db.microsoftConnection.findUniqueOrThrow({ where: { id: connectionId } });
const ledger = (graphMessageId: string) =>
  state.db.inboundMail.findUniqueOrThrow({ where: { connectionId_graphMessageId: { connectionId, graphMessageId } } });

async function connect(workspaceId: string, email: string) {
  const user = `user_${randomBytes(3).toString("hex")}`;
  await state.db.user.create({ data: { id: user, email: `${user}@aic.example` } });
  const c = await state.db.microsoftConnection.create({
    data: {
      workspaceId,
      userId: user,
      msTenantId: "tid",
      msUserId: `oid_${user}`,
      email,
      grantedScopes: ["Calendars.ReadWrite", "Mail.ReadWrite", "Mail.Send"],
      accessTokenEnc: encryptToken("access"),
      accessExpiresAt: new Date(Date.now() + 3_600_000),
      refreshTokenEnc: encryptToken("refresh"),
    },
  });
  return c.id;
}

describe.skipIf(!DATABASE_URL)("Outlook mail into the lead inbox", () => {
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
    state.graph = client();
    ws = `ws_${randomBytes(4).toString("hex")}`;
    await state.db.user.create({ data: { id: `owner_${ws}`, email: `owner_${ws}@aic.example` } });
    await state.db.workspace.create({ data: { id: ws, name: ws, ownerId: `owner_${ws}` } });
    connectionId = await connect(ws, "service@aic.example");
  });

  async function subscribeMail() {
    expect(await startMailIngest(connectionId, client())).toBe(true);
    const sub = await state.db.graphSubscription.findFirstOrThrow({ where: { connectionId, resource: MAIL_RESOURCE } });
    await state.db.graphSubscription.update({ where: { id: sub.id }, data: { clientStateHash: hashClientState("mail-state") } });
    return sub;
  }
  const notify = (subscriptionId: string, id: string) =>
    ingestNotifications([{ subscriptionId, clientState: "mail-state", changeType: "created", resourceData: { id } }]);

  it("posts a new Inbox message to Relay once, whether it comes by webhook or delta", async () => {
    const sub = await subscribeMail();
    // Subscribed for created Inbox messages with immutable ids.
    const create = graph.calls.find((c) => c.method === "POST" && c.path === "/subscriptions")!;
    expect(create.body).toMatchObject({ resource: MAIL_RESOURCE, changeType: "created" });
    expect(create.headers.prefer).toContain('IdType="ImmutableId"');

    const m = graph.receiveMail({
      from: "Jordan@Example.com",
      body: "Our furnace stopped last night.",
      attachments: [
        { id: "att1", name: "photo.jpg", contentType: "image/jpeg", size: 10, isInline: false, content: "jpeg-bytes" },
        { id: "att2", name: "logo.png", contentType: "image/png", size: 10, isInline: true, content: "png" },
      ],
    });
    await notify(sub.graphSubscriptionId, m.id);
    await notify(sub.graphSubscriptionId, m.id);
    await processPendingNotifications({ graph: () => client(), relay });
    await syncInbox(connectionId, deps());
    await notify(sub.graphSubscriptionId, m.id);
    await processPendingNotifications({ graph: () => client(), relay });

    expect(relay.inbound).toHaveLength(1);
    expect(relay.inbound[0]).toEqual({
      channel: "EMAIL",
      channelAccountRef: "service@aic.example",
      externalThreadId: m.conversationId,
      externalMessageId: m.internetMessageId,
      occurredAt: new Date(m.receivedDateTime!).toISOString(),
      from: { displayName: "Jordan Lee", identities: [{ kind: "EMAIL", value: "jordan@example.com" }] },
      subject: "Furnace quote",
      body: "Our furnace stopped last night.",
      kind: "MESSAGE",
      attachments: [
        {
          name: "photo.jpg",
          url: `https://app.aic.example/api/microsoft/mail/attachments/${connectionId}/${m.id}/att1`,
          contentType: "image/jpeg",
        },
      ],
    });
    // The message is fetched once; later deliveries stop at the ledger.
    expect(graph.count("GET", new RegExp(`^/me/messages/${m.id}\\?`))).toBe(1);
    expect(await ledger(m.id)).toMatchObject({ status: "DELIVERED", internetMessageId: m.internetMessageId, relayMessageId: "rmsg1" });
  });

  it("skips mail from the mailbox itself, internal senders, system senders and mail older than the start", async () => {
    await subscribeMail();
    const own = graph.receiveMail({ from: "service@aic.example" });
    const sentAs = graph.receiveMail({ from: "someone@else.example", sender: { emailAddress: { address: "SERVICE@aic.example" } } });
    const staff = graph.receiveMail({ from: "tech@aic.example" });
    const bounce = graph.receiveMail({ from: "MAILER-DAEMON@mx.example" });
    const old = graph.receiveMail({ from: "old@example.com", receivedDateTime: new Date(Date.now() - 30 * 86_400_000).toISOString() });
    graph.receiveMail({ from: "lead@example.com" });

    for (const m of [own, sentAs, staff, bounce, old]) await processMessage(await connection(), m.id, deps());
    await syncInbox(connectionId, deps());

    expect(relay.inbound.map((e) => e.from.identities[0].value)).toEqual(["lead@example.com"]);
    expect((await ledger(own.id)).skipReason).toBe("FROM_MAILBOX");
    expect((await ledger(sentAs.id)).skipReason).toBe("FROM_MAILBOX");
    expect((await ledger(staff.id)).skipReason).toBe("INTERNAL_SENDER");
    expect((await ledger(bounce.id)).skipReason).toBe("SYSTEM_SENDER");
    expect((await ledger(old.id)).skipReason).toBe("BEFORE_INGEST_START");
    // The delta backstop does not even look up mail from before the start.
    expect(graph.count("GET", new RegExp(`^/me/messages/${old.id}\\?`))).toBe(1);
  });

  it("never reads a mailbox that is not the service mailbox", async () => {
    const staffConnection = await connect(ws, "carla@aic.example");
    expect(await startMailIngest(staffConnection, client())).toBe(false);
    graph.receiveMail({ from: "lead@example.com" });
    await syncInbox(staffConnection, deps());
    expect(graph.calls.filter((c) => c.path.includes("messages"))).toHaveLength(0);
    expect(await state.db.graphSubscription.count({ where: { connectionId: staffConnection } })).toBe(0);
  });

  it("retries Relay outages with backoff and dead-letters a message Relay refuses", async () => {
    await subscribeMail();
    const a = graph.receiveMail({ from: "a@example.com" });
    const b = graph.receiveMail({ from: "b@example.com" });
    relay.inboundFailures.push(503, 400);

    const t0 = new Date();
    expect(await syncInbox(connectionId, deps(t0))).toMatchObject({ failed: 1, dead: 1 });
    expect(await ledger(a.id)).toMatchObject({ status: "FAILED", attempts: 1, lastError: "relay 503 error /events" });
    expect(await ledger(b.id)).toMatchObject({ status: "DEAD" });

    // Not due yet.
    expect(await retryFailedMail(() => client(), relay, t0)).toEqual({});
    // Due: delivered. The refused one is never sent again.
    expect(await retryFailedMail(() => client(), relay, new Date(t0.getTime() + 3 * 60_000))).toEqual({ delivered: 1 });
    expect(relay.inbound.map((e) => e.externalMessageId)).toEqual([a.internetMessageId]);
    expect((await connection()).mailDeltaLink).toContain("deltatoken=2");
  });

  it("catches up through the delta when notifications are missed, and restarts an expired delta", async () => {
    const sub = await subscribeMail();
    graph.receiveMail({ from: "first@example.com" });
    await syncInbox(connectionId, deps());

    // Graph says it dropped notifications; the lifecycle event triggers a delta round.
    graph.receiveMail({ from: "second@example.com" });
    await ingestNotifications([{ subscriptionId: sub.graphSubscriptionId, clientState: "mail-state", lifecycleEvent: "missed" }]);
    await processPendingNotifications({ graph: () => client(), relay });
    expect(relay.inbound).toHaveLength(2);

    // An expired delta token starts again from mailIngestFrom; the ledger absorbs the overlap.
    await state.db.microsoftConnection.update({ where: { id: connectionId }, data: { mailDeltaLink: "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=expired" } });
    graph.receiveMail({ from: "third@example.com" });
    expect(await syncInbox(connectionId, deps())).toMatchObject({ delivered: 1, done: 2 });
    expect(relay.inbound).toHaveLength(3);
  });

  it("replaces a removed or lapsed mail subscription with another mail subscription", async () => {
    const sub = await subscribeMail();
    await ingestNotifications([{ subscriptionId: sub.graphSubscriptionId, clientState: "mail-state", lifecycleEvent: "subscriptionRemoved" }]);
    await processPendingNotifications({ graph: () => client(), relay });
    const live = await state.db.graphSubscription.findFirstOrThrow({ where: { connectionId, status: "ACTIVE" } });
    expect(live.resource).toBe(MAIL_RESOURCE);

    graph.subscriptions.delete(live.graphSubscriptionId);
    expect(await renewSubscription(live.id, client())).toBe("recreated");
    const after = await state.db.graphSubscription.findMany({ where: { connectionId, status: "ACTIVE" } });
    expect(after.map((s) => s.resource)).toEqual([MAIL_RESOURCE]);
  });

  describe("attachment downloads", () => {
    const call = (messageId: string, attachmentId: string) =>
      getAttachment(new Request("https://app.aic.example/x") as never, { params: Promise.resolve({ connectionId, messageId, attachmentId }) });

    it("serves an ingested message's attachment to its workspace only, as a download", async () => {
      await subscribeMail();
      const m = graph.receiveMail({
        from: "lead@example.com",
        attachments: [{ id: "att1", name: "quote.html", contentType: "text/html", size: 4, isInline: false, content: "<b>" }],
      });
      await syncInbox(connectionId, deps());

      state.context = null;
      expect((await call(m.id, "att1")).status).toBe(401);
      state.context = { workspaceId: "ws_other", userId: "x" };
      expect((await call(m.id, "att1")).status).toBe(404);

      state.context = { workspaceId: ws, userId: "x" };
      const res = await call(m.id, "att1");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("<b>");
      // HTML never renders in the app's origin.
      expect(res.headers.get("content-type")).toBe("application/octet-stream");
      expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
    });

    it("refuses messages that were skipped or never ingested", async () => {
      await subscribeMail();
      const own = graph.receiveMail({
        from: "service@aic.example",
        attachments: [{ id: "att1", name: "a.pdf", contentType: "application/pdf", size: 4, isInline: false, content: "%PDF" }],
      });
      await syncInbox(connectionId, deps());
      state.context = { workspaceId: ws, userId: "x" };
      expect((await call(own.id, "att1")).status).toBe(404);
      expect((await call("unknown", "att1")).status).toBe(404);
    });
  });
});
