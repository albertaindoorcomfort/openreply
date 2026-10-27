import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db/client";

export const SCOPES = [
  "events:ingest",
  "timeline:write",
  "inbox:read",
  "assist:write",
  "tasks:write",
  "messages:send",
  "forms:submit",
  "feedback:write",
  // Relay's social flows: read flows and their results, and create one on an approval grant.
  "flows:read",
  "flows:write",
] as const;
export type Scope = (typeof SCOPES)[number];

const hash = (secret: string) => createHash("sha256").update(secret, "utf8").digest("hex");

/** Creates a key and returns the only copy of its secret. */
export async function mintApiKey(workspaceId: string, name: string, scopes: Scope[]) {
  for (const s of scopes) if (!SCOPES.includes(s)) throw new Error(`Unknown scope ${s}`);
  if (scopes.includes("forms:submit") && scopes.length > 1) {
    // A form key is embedded in a public web page, so it may do nothing else.
    throw new Error("forms:submit keys cannot hold other scopes");
  }
  const prefix = randomBytes(6).toString("hex");
  const secret = `orly_${prefix}_${randomBytes(32).toString("base64url")}`;
  const key = await prisma.relayApiKey.create({
    data: { workspaceId, name, scopes, keyPrefix: prefix, keyHash: hash(secret) },
  });
  return { id: key.id, secret };
}

const KEY_FORMAT = /^orly_([0-9a-f]{12})_[A-Za-z0-9_-]{43}$/;

export interface ApiKeyPrincipal {
  keyId: string;
  name: string;
  workspaceId: string;
  scopes: string[];
}

/** Resolves a presented secret to its key. Unknown, malformed and revoked keys all return null. */
export async function verifyApiKey(secret: string): Promise<ApiKeyPrincipal | null> {
  const m = KEY_FORMAT.exec(secret);
  if (!m) return null;
  const key = await prisma.relayApiKey.findUnique({ where: { keyPrefix: m[1] } });
  if (!key || key.revokedAt) return null;
  const a = Buffer.from(key.keyHash, "hex");
  const b = Buffer.from(hash(secret), "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  // Coarse last-used stamp; skip the write when it is recent.
  if (!key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > 60_000) {
    void prisma.relayApiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  }
  return { keyId: key.id, name: key.name, workspaceId: key.workspaceId, scopes: key.scopes };
}

export async function revokeApiKey(workspaceId: string, keyId: string) {
  await prisma.relayApiKey.updateMany({ where: { id: keyId, workspaceId }, data: { revokedAt: new Date() } });
}
