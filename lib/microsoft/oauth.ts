import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import { z } from "zod";
import { requireEnv } from "@/lib/env";
import { BASE_SCOPES, TRANSCRIPT_SCOPES, microsoftRedirectUri, microsoftTenant } from "./config";

/**
 * Microsoft identity platform, authorization code flow with PKCE, for a
 * confidential client. The state is signed and names the workspace and user
 * that started the flow; the PKCE verifier stays in an httpOnly cookie so it
 * never travels in a URL next to the code.
 */

const STATE_MAX_AGE_MS = 10 * 60 * 1000;
export const PKCE_COOKIE = "aic_ms_pkce";

export interface MicrosoftOAuthState {
  workspaceId: string;
  userId: string;
  nonce: string;
  transcripts: boolean;
  ts: number;
}

function sign(payload: string): string {
  return createHmac("sha256", requireEnv("NEXTAUTH_SECRET")).update(`ms:${payload}`).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function startAuthorization(input: { workspaceId: string; userId: string; transcripts: boolean }) {
  const nonce = randomBytes(16).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const payload = Buffer.from(
    JSON.stringify({ ...input, nonce, ts: Date.now() } satisfies MicrosoftOAuthState)
  ).toString("base64url");
  const state = `${payload}.${sign(payload)}`;

  const scopes = [...BASE_SCOPES, ...(input.transcripts ? TRANSCRIPT_SCOPES : [])];
  const params = new URLSearchParams({
    client_id: requireEnv("MICROSOFT_CLIENT_ID"),
    response_type: "code",
    redirect_uri: microsoftRedirectUri(),
    response_mode: "query",
    scope: scopes.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  const url = `https://login.microsoftonline.com/${encodeURIComponent(microsoftTenant())}/oauth2/v2.0/authorize?${params}`;
  return { url, cookieValue: `${nonce}.${verifier}` };
}

/** Returns the state only if it is signed, fresh and matches the PKCE cookie. */
export function verifyCallback(state: string | null, cookieValue: string | undefined) {
  if (!state || !cookieValue) return null;
  const [payload, signature] = state.split(".");
  if (!payload || !signature || !safeEqual(signature, sign(payload))) return null;
  let parsed: MicrosoftOAuthState;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed.workspaceId || !parsed.userId || Date.now() - parsed.ts > STATE_MAX_AGE_MS) return null;
  const [cookieNonce, verifier] = cookieValue.split(".");
  if (!cookieNonce || !verifier || !safeEqual(cookieNonce, parsed.nonce)) return null;
  return { state: parsed, verifier };
}

const tokenResponse = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.coerce.number(),
  scope: z.string().default(""),
  id_token: z.string().optional(),
});
export type TokenResponse = z.infer<typeof tokenResponse>;

export class MicrosoftTokenError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(`microsoft token ${status}: ${code}`);
  }
  /** The refresh token is dead; the user has to connect again. */
  get needsReauth() {
    return this.code === "invalid_grant" || this.code === "interaction_required";
  }
}

async function tokenCall(body: Record<string, string>, f: typeof fetch): Promise<TokenResponse> {
  const res = await f(
    `https://login.microsoftonline.com/${encodeURIComponent(microsoftTenant())}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: requireEnv("MICROSOFT_CLIENT_ID"),
        client_secret: requireEnv("MICROSOFT_CLIENT_SECRET"),
        ...body,
      }),
      signal: AbortSignal.timeout(15_000),
    }
  );
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    // Only the error code: the description can echo user identifiers.
    throw new MicrosoftTokenError(typeof json.error === "string" ? json.error : "token_error", res.status);
  }
  return tokenResponse.parse(json);
}

export function exchangeCode(code: string, verifier: string, f: typeof fetch = fetch) {
  return tokenCall(
    { grant_type: "authorization_code", code, redirect_uri: microsoftRedirectUri(), code_verifier: verifier },
    f
  );
}

export function refreshAccessToken(refreshToken: string, scopes: string[], f: typeof fetch = fetch) {
  return tokenCall({ grant_type: "refresh_token", refresh_token: refreshToken, scope: scopes.join(" ") }, f);
}

const idClaims = z.object({
  tid: z.string(),
  oid: z.string(),
  aud: z.string(),
  exp: z.number(),
  preferred_username: z.string().optional(),
  email: z.string().optional(),
  name: z.string().optional(),
});

/**
 * Reads the id_token returned by the token endpoint. It came straight from
 * Microsoft over TLS in the code exchange, which OIDC accepts in place of a
 * signature check; audience and expiry are still checked.
 */
export function readIdToken(idToken: string | undefined) {
  if (!idToken) throw new MicrosoftTokenError("missing_id_token", 400);
  const part = idToken.split(".")[1];
  if (!part) throw new MicrosoftTokenError("bad_id_token", 400);
  const claims = idClaims.parse(JSON.parse(Buffer.from(part, "base64url").toString("utf8")));
  if (claims.aud !== requireEnv("MICROSOFT_CLIENT_ID")) throw new MicrosoftTokenError("id_token_audience", 400);
  if (claims.exp * 1000 < Date.now() - 5 * 60 * 1000) throw new MicrosoftTokenError("id_token_expired", 400);
  const tenant = microsoftTenant();
  const pinned = /^[0-9a-f-]{36}$/i.test(tenant);
  if (pinned && claims.tid.toLowerCase() !== tenant.toLowerCase()) {
    throw new MicrosoftTokenError("wrong_tenant", 403);
  }
  return claims;
}

export function scopesOf(token: TokenResponse): string[] {
  return token.scope.split(/\s+/).filter(Boolean);
}
