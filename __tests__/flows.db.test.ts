/**
 * Relay flows through the service API, against a real Postgres: the grant
 * check, the one-flow-per-approval index and workspace isolation all live in
 * the database or the route. Skipped without a database:
 *
 *   TEST_DATABASE_URL=postgresql://postgres@localhost:5432/postgres \
 *     npx vitest run __tests__/flows.db.test.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../app/generated/prisma/client";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIR = path.join(__dirname, "..", "prisma", "migrations");

const state = vi.hoisted(() => ({
  db: undefined as unknown as import("../app/generated/prisma/client").PrismaClient,
}));
vi.mock("@/lib/db/client", () => ({
  get prisma() {
    return state.db;
  },
}));
vi.mock("@/lib/workspace-access", () => ({ hasWorkspaceRole: () => true, getCurrentWorkspaceContext: async () => null }));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: () => ({ incr: async () => 1, expire: async () => 1 }) }));

import { mintApiKey } from "../lib/leads/keys";
import { mintFlowGrant, mintSendGrant, sha256Hex } from "../lib/leads/grant";
import { GET as listGET, POST as createPOST } from "../app/api/flows/v1/route";
import { GET as statsGET } from "../app/api/flows/v1/[id]/route";

const SECRET = "test-grant-secret-0123456789abcdefghij";
const schema = `flows_${randomBytes(4).toString("hex")}`;
let sql: Client;
let writeKey: string;
let readKey: string;
let otherKey: string;

const flow = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ name: "Furnace tune-up", postId: "17900000000000001", keywords: ["tune"], dmMessage: "Here is the booking link.", publicReplies: ["Sent you a DM!"], linkUrl: "https://aic.test/book", ...over });
const apr = () => `apr_${randomBytes(8).toString("hex")}`;
const grant = (body: string, approvalId = apr(), workspaceId = "ws_a") =>
  mintFlowGrant(SECRET, { approvalId, workspaceId, bodySha256: sha256Hex(body), approvedBy: "usr_owner" });

function post(body: string, key: string, g?: string) {
  return createPOST(new NextRequest("http://localhost/api/flows/v1", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}`, ...(g ? { "x-relay-grant": g } : {}) },
    body,
  }), undefined as never);
}
const get = (url: string, key: string) => new NextRequest(url, { headers: { authorization: `Bearer ${key}` } });

describe.skipIf(!DATABASE_URL)("Relay flows API on Postgres", () => {
  beforeAll(async () => {
    process.env.RELAY_GRANT_SECRET = SECRET;
    sql = new Client({ connectionString: DATABASE_URL });
    await sql.connect();
    await sql.query(`CREATE SCHEMA "${schema}"`);
    await sql.query(`SET search_path TO "${schema}"`);
    const dirs = readdirSync(MIGRATIONS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    for (const dir of dirs) await sql.query(readFileSync(path.join(MIGRATIONS_DIR, dir, "migration.sql"), "utf8"));
    await sql.query(`
      INSERT INTO "User" ("id", "email", "updatedAt") VALUES ('user_a', 'a@test.dev', now()), ('user_b', 'b@test.dev', now());
      INSERT INTO "Workspace" ("id", "name", "ownerId", "updatedAt") VALUES ('ws_a', 'AIC', 'user_a', now()), ('ws_b', 'Other', 'user_b', now());
      INSERT INTO "InstagramAccount" ("id", "workspaceId", "instagramId", "username", "accessToken", "updatedAt")
        VALUES ('ig_a', 'ws_a', '111', 'aic', 'token', now()), ('ig_b', 'ws_b', '222', 'other', 'token', now());
    `);
    const url = new URL(DATABASE_URL!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    state.db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString(), max: 4 }, { schema }) });
    writeKey = (await mintApiKey("ws_a", "social", ["flows:read", "flows:write"])).secret;
    readKey = (await mintApiKey("ws_a", "reader", ["flows:read"])).secret;
    otherKey = (await mintApiKey("ws_b", "other", ["flows:read", "flows:write"])).secret;
  });

  afterAll(async () => {
    await state.db?.$disconnect();
    if (sql) {
      await sql.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await sql.end();
    }
  });

  it("creates the approved flow once, live on the post with its replies and link", async () => {
    const body = flow();
    const g = grant(body);
    const first = await post(body, writeKey, g);
    expect(first.status).toBe(201);
    const { flowId } = await first.json();
    const again = await post(body, writeKey, g);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ flowId, replay: true });

    const row = await state.db.automation.findUniqueOrThrow({ where: { id: flowId }, include: { trackedLinks: true } });
    expect(row).toMatchObject({ workspaceId: "ws_a", instagramAccountId: "ig_a", postId: "17900000000000001", isActive: true, publicReplyEnabled: true, publicReplyMessages: ["Sent you a DM!"] });
    expect(row.trackedLinks.map((l) => l.destinationUrl)).toEqual(["https://aic.test/book"]);
  });

  it("refuses a flow without a grant, with a changed body, or on another workspace's grant", async () => {
    const body = flow({ name: "Second" });
    expect((await post(body, writeKey)).status).toBe(403);
    const changed = await post(flow({ name: "Second", dmMessage: "Something else" }), writeKey, grant(body));
    expect((await changed.json()).error).toBe("GRANT_BODY_MISMATCH");
    expect((await (await post(body, writeKey, grant(body, apr(), "ws_b"))).json()).error).toBe("GRANT_WRONG_WORKSPACE");
    // A send grant is not a flow grant.
    const send = mintSendGrant(SECRET, { approvalId: apr(), workspaceId: "ws_a", draftId: "d1", textSha256: sha256Hex(body), approvedBy: "u" });
    expect((await (await post(body, writeKey, send)).json()).error).toBe("GRANT_MALFORMED");
    // A read-only key cannot create, whatever the grant.
    expect((await post(body, readKey, grant(body))).status).toBe(403);
  });

  it("lists flows and results only for the key's own workspace", async () => {
    const mine = await (await listGET(get("http://localhost/api/flows/v1", readKey), undefined as never)).json();
    expect(mine.flows.length).toBe(1);
    expect(mine.flows[0].results).toEqual({ dmsSent: 0, dmsSkipped: 0, dmsFailed: 0, publicReplies: 0, clicks: 0, ctr: 0 });
    const theirs = await (await listGET(get("http://localhost/api/flows/v1", otherKey), undefined as never)).json();
    expect(theirs.flows).toEqual([]);
    const id = mine.flows[0].id;
    const stats = await statsGET(get(`http://localhost/api/flows/v1/${id}`, otherKey), { params: Promise.resolve({ id }) });
    expect(stats.status).toBe(404);
    const own = await statsGET(get(`http://localhost/api/flows/v1/${id}`, readKey), { params: Promise.resolve({ id }) });
    expect((await own.json()).topKeywords).toEqual([]);
  });
});
