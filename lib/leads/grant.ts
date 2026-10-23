/**
 * Send grants.
 *
 * Sending a draft is the one Relay action with a real-world effect, so it needs
 * proof that a human approved it. The control plane (Apollo) records that
 * approval, consumes it once, and then signs a short-lived grant that names the
 * exact workspace, draft and text hash. OpenReply checks the signature and those
 * fields, and stores the approval id under a unique index so a grant sends once.
 *
 * Wire format (shared with Apollo, contracts.md section 13):
 * base64url(JSON claims) + "." + base64url(HMAC-SHA256(secret, base64url(JSON claims))).
 *
 * This file has no app imports: the control plane can copy it as-is to mint
 * grants with the same code that verifies them.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const GRANT_AUDIENCE = "openreply.relay.send";
/** Longest lifetime a grant may claim, whatever its exp says. */
export const MAX_GRANT_TTL_SECONDS = 600;
const MIN_SECRET_LENGTH = 32;

export interface SendGrantClaims {
  /** Optional on the wire (Apollo omits them); checked when present. */
  v?: 1;
  aud?: typeof GRANT_AUDIENCE;
  approvalId: string;
  workspaceId: string;
  draftId: string;
  textSha256: string;
  /** Who approved, for the audit trail. Never used for authorization here. */
  approvedBy: string;
  iat: number;
  exp: number;
}

export type GrantCheck =
  | { ok: true; claims: SendGrantClaims }
  | { ok: false; reason: string };

export const sha256Hex = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

const b64url = (buf: Buffer) => buf.toString("base64url");

function sign(secret: string, body: string): Buffer {
  return createHmac("sha256", secret).update(body).digest();
}

function assertSecret(secret: string | undefined): asserts secret is string {
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `RELAY_GRANT_SECRET must be set to at least ${MIN_SECRET_LENGTH} characters`
    );
  }
}

export function mintSendGrant(
  secret: string,
  input: Omit<SendGrantClaims, "v" | "aud" | "iat" | "exp">,
  ttlSeconds = 300,
  now = Date.now()
): string {
  assertSecret(secret);
  const iat = Math.floor(now / 1000);
  const claims: SendGrantClaims = {
    v: 1,
    aud: GRANT_AUDIENCE,
    ...input,
    iat,
    exp: iat + Math.min(ttlSeconds, MAX_GRANT_TTL_SECONDS),
  };
  const body = b64url(Buffer.from(JSON.stringify(claims), "utf8"));
  return `${body}.${b64url(sign(secret, body))}`;
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const HEX64 = /^[0-9a-f]{64}$/;

function parseClaims(raw: unknown): SendGrantClaims | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const ok =
    (c.v === undefined || c.v === 1) &&
    (c.aud === undefined || c.aud === GRANT_AUDIENCE) &&
    typeof c.approvalId === "string" && ID.test(c.approvalId) &&
    typeof c.workspaceId === "string" && ID.test(c.workspaceId) &&
    typeof c.draftId === "string" && ID.test(c.draftId) &&
    typeof c.textSha256 === "string" && HEX64.test(c.textSha256) &&
    typeof c.approvedBy === "string" && c.approvedBy.length > 0 && c.approvedBy.length <= 128 &&
    Number.isInteger(c.iat) && Number.isInteger(c.exp);
  return ok ? (c as unknown as SendGrantClaims) : null;
}

/** Checks signature, shape and time only. The caller matches the claims to the draft. */
export function verifySendGrant(
  secret: string | undefined,
  token: string,
  now = Date.now()
): GrantCheck {
  assertSecret(secret);
  const parts = token.split(".");
  if (parts.length !== 2 || token.length > 4096) return { ok: false, reason: "MALFORMED" };
  const [body, sig] = parts;
  const expected = sign(secret, body);
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: "BAD_SIGNATURE" };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }
  const claims = parseClaims(decoded);
  if (!claims) return { ok: false, reason: "MALFORMED" };
  const nowSec = Math.floor(now / 1000);
  if (claims.exp <= nowSec) return { ok: false, reason: "EXPIRED" };
  // Clock skew allowance of 30s for iat; a grant can never outlive the max TTL.
  if (claims.iat > nowSec + 30) return { ok: false, reason: "NOT_YET_VALID" };
  if (claims.exp - claims.iat > MAX_GRANT_TTL_SECONDS) return { ok: false, reason: "TTL_TOO_LONG" };
  return { ok: true, claims };
}

/**
 * Flow grants.
 *
 * Creating a Relay flow through the service API switches on automatic comment
 * replies and DMs, so it needs the same proof of a human approval as a send.
 * The grant names the workspace and the SHA-256 of the exact request body, so
 * the approved flow is the one created. The approval id is stored on the flow
 * under a unique index, so a grant creates one flow.
 */
export const FLOW_GRANT_AUDIENCE = "openreply.relay.flow";

export interface FlowGrantClaims {
  v: 1;
  aud: typeof FLOW_GRANT_AUDIENCE;
  approvalId: string;
  workspaceId: string;
  bodySha256: string;
  /** Who approved, for the audit trail. Never used for authorization here. */
  approvedBy: string;
  iat: number;
  exp: number;
}

export type FlowGrantCheck =
  | { ok: true; claims: FlowGrantClaims }
  | { ok: false; reason: string };

export function mintFlowGrant(
  secret: string,
  input: Omit<FlowGrantClaims, "v" | "aud" | "iat" | "exp">,
  ttlSeconds = 300,
  now = Date.now()
): string {
  assertSecret(secret);
  const iat = Math.floor(now / 1000);
  const claims: FlowGrantClaims = {
    v: 1,
    aud: FLOW_GRANT_AUDIENCE,
    ...input,
    iat,
    exp: iat + Math.min(ttlSeconds, MAX_GRANT_TTL_SECONDS),
  };
  const body = b64url(Buffer.from(JSON.stringify(claims), "utf8"));
  return `${body}.${b64url(sign(secret, body))}`;
}

function parseFlowClaims(raw: unknown): FlowGrantClaims | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  // Version and audience are required here, so a send grant can never pass as a flow grant.
  const ok =
    c.v === 1 &&
    c.aud === FLOW_GRANT_AUDIENCE &&
    typeof c.approvalId === "string" && ID.test(c.approvalId) &&
    typeof c.workspaceId === "string" && ID.test(c.workspaceId) &&
    typeof c.bodySha256 === "string" && HEX64.test(c.bodySha256) &&
    typeof c.approvedBy === "string" && c.approvedBy.length > 0 && c.approvedBy.length <= 128 &&
    Number.isInteger(c.iat) && Number.isInteger(c.exp);
  return ok ? (c as unknown as FlowGrantClaims) : null;
}

/** Checks signature, shape and time only. The caller matches the claims to the request. */
export function verifyFlowGrant(
  secret: string | undefined,
  token: string,
  now = Date.now()
): FlowGrantCheck {
  assertSecret(secret);
  const parts = token.split(".");
  if (parts.length !== 2 || token.length > 4096) return { ok: false, reason: "MALFORMED" };
  const [body, sig] = parts;
  const expected = sign(secret, body);
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: "BAD_SIGNATURE" };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }
  const claims = parseFlowClaims(decoded);
  if (!claims) return { ok: false, reason: "MALFORMED" };
  const nowSec = Math.floor(now / 1000);
  if (claims.exp <= nowSec) return { ok: false, reason: "EXPIRED" };
  if (claims.iat > nowSec + 30) return { ok: false, reason: "NOT_YET_VALID" };
  if (claims.exp - claims.iat > MAX_GRANT_TTL_SECONDS) return { ok: false, reason: "TTL_TOO_LONG" };
  return { ok: true, claims };
}
