import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { mintSendGrant, sha256Hex, verifySendGrant } from "../lib/leads/grant";
import { normalizeIdentity, normalizePhone } from "../lib/leads/normalize";

const SECRET = "s".repeat(40);
const base = { approvalId: "apr_1", workspaceId: "ws_1", draftId: "d_1", textSha256: sha256Hex("hello"), approvedBy: "usr_1" };

describe("send grants", () => {
  it("round-trips a fresh grant", () => {
    const check = verifySendGrant(SECRET, mintSendGrant(SECRET, base));
    expect(check.ok && check.claims.draftId).toBe("d_1");
  });

  it("accepts Apollo's wire format without v and aud", () => {
    const iat = Math.floor(Date.now() / 1000);
    const body = Buffer.from(JSON.stringify({ ...base, iat, exp: iat + 300 })).toString("base64url");
    const sig = createHmac("sha256", SECRET).update(body).digest("base64url");
    expect(verifySendGrant(SECRET, `${body}.${sig}`).ok).toBe(true);
  });

  it("rejects a wrong secret, a tampered body, expiry and an over-long lifetime", () => {
    const token = mintSendGrant(SECRET, base);
    expect(verifySendGrant("x".repeat(40), token)).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
    const [body, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), draftId: "d_2" })).toString("base64url");
    expect(verifySendGrant(SECRET, `${forged}.${sig}`)).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
    expect(verifySendGrant(SECRET, token, Date.now() + 301_000)).toEqual({ ok: false, reason: "EXPIRED" });
    const iat = Math.floor(Date.now() / 1000);
    const long = Buffer.from(JSON.stringify({ ...base, iat, exp: iat + 3600 })).toString("base64url");
    expect(verifySendGrant(SECRET, `${long}.${createHmac("sha256", SECRET).update(long).digest("base64url")}`)).toEqual({ ok: false, reason: "TTL_TOO_LONG" });
  });

  it("refuses to run without a strong secret", () => {
    expect(() => verifySendGrant(undefined, "a.b")).toThrow(/RELAY_GRANT_SECRET/);
    expect(() => mintSendGrant("short", base)).toThrow(/RELAY_GRANT_SECRET/);
  });
});

describe("identity normalisation", () => {
  it("matches the same person across formats", () => {
    expect(normalizeIdentity("EMAIL", "  Jordan.Lee@Example.COM ")).toBe("jordan.lee@example.com");
    expect(normalizePhone("(403) 555-0100")).toBe("+14035550100");
    expect(normalizePhone("1-403-555-0100")).toBe("+14035550100");
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizeIdentity("EMAIL", "not an email")).toBeNull();
    expect(normalizePhone("555-0100")).toBeNull();
  });
});
