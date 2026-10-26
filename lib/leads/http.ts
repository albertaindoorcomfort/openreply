import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";
import { getRedisConnection } from "@/lib/queue/client";
import { getCurrentWorkspaceContext, hasWorkspaceRole } from "@/lib/workspace-access";
import type { WorkspaceRole } from "@/app/generated/prisma/client";
import { LeadError } from "./errors";
import { verifyApiKey, type ApiKeyPrincipal, type Scope } from "./keys";
import type { Actor } from "./timeline";

export type ServiceActor = Actor & { key: ApiKeyPrincipal };
export type UserActor = Actor & { id: string; role: WorkspaceRole };

export function errorResponse(err: unknown) {
  if (err instanceof LeadError) return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
  if (err instanceof ZodError) {
    return NextResponse.json(
      { error: "INVALID_REQUEST", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
      { status: 400 }
    );
  }
  if (err instanceof SyntaxError) return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
  console.error("[Leads API]", err);
  return NextResponse.json({ error: "INTERNAL" }, { status: 500 });
}

/**
 * Fixed-window counter in Redis. Fails closed: if the limiter cannot be
 * reached, the request is refused rather than let through unmetered.
 */
export async function rateLimit(bucket: string, max: number, windowSeconds: number) {
  const key = `leads:rl:${bucket}:${Math.floor(Date.now() / 1000 / windowSeconds)}`;
  try {
    const redis = getRedisConnection();
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, windowSeconds + 1);
    if (n > max) throw new LeadError("RATE_LIMITED", 429, "Too many requests. Slow down and retry.");
  } catch (err) {
    if (err instanceof LeadError) throw err;
    throw new LeadError("RATE_LIMITER_UNAVAILABLE", 503);
  }
}

const SERVICE_LIMIT_PER_MINUTE = Number(process.env.RELAY_KEY_RATE_LIMIT ?? 600);

/**
 * Authenticates a service key and checks one scope. The workspace always comes
 * from the key. Agent work (drafts, assessments, handoffs) is attributed to
 * the agent named in x-agent-id, default AIC OS.
 */
export async function serviceActor(request: NextRequest, scope: Scope): Promise<ServiceActor> {
  const header = request.headers.get("authorization") ?? "";
  const secret = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const key = secret ? await verifyApiKey(secret) : null;
  if (!key) throw new LeadError("UNAUTHENTICATED", 401);
  if (!key.scopes.includes(scope)) throw new LeadError("MISSING_SCOPE", 403, `This key lacks ${scope}`);
  await rateLimit(`key:${key.keyId}`, SERVICE_LIMIT_PER_MINUTE, 60);
  if (scope === "assist:write") {
    const agent = request.headers.get("x-agent-id") ?? "carla";
    if (!/^[a-z_]{1,64}$/.test(agent)) throw new LeadError("INVALID_AGENT_ID", 400);
    return { kind: "AGENT", id: agent, workspaceId: key.workspaceId, key };
  }
  return { kind: "SERVICE", id: `key:${key.name}`, workspaceId: key.workspaceId, key };
}

/** The signed-in person and their workspace. Mutations from the browser also pass a same-origin check. */
export async function userActor(request: NextRequest, minimumRole: WorkspaceRole = "MEMBER"): Promise<UserActor> {
  if (request.method !== "GET" && request.method !== "HEAD") assertSameOrigin(request);
  const ctx = await getCurrentWorkspaceContext();
  if (!ctx) throw new LeadError("UNAUTHENTICATED", 401);
  if (!hasWorkspaceRole(ctx.role, minimumRole)) throw new LeadError("FORBIDDEN", 403);
  await rateLimit(`user:${ctx.userId}`, 300, 60);
  return { kind: "USER", id: ctx.userId, workspaceId: ctx.workspaceId, role: ctx.role };
}

/** CSRF defence for cookie-authenticated writes: the Origin must be this site. */
function assertSameOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!origin || !host) throw new LeadError("CSRF_CHECK_FAILED", 403);
  try {
    if (new URL(origin).host !== host) throw new LeadError("CSRF_CHECK_FAILED", 403);
  } catch (err) {
    if (err instanceof LeadError) throw err;
    throw new LeadError("CSRF_CHECK_FAILED", 403);
  }
}

export async function readJson(request: NextRequest, maxBytes = 256_000): Promise<unknown> {
  const text = await request.text();
  if (text.length > maxBytes) throw new LeadError("PAYLOAD_TOO_LARGE", 413);
  return text ? JSON.parse(text) : {};
}

type Handler<C> = (request: NextRequest, context: C) => Promise<Response>;

/** Wraps a route handler so refusals become JSON errors with the right status. */
export function route<C>(fn: Handler<C>): Handler<C> {
  return async (request, context) => {
    try {
      return await fn(request, context);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export const json = (data: unknown, status = 200) =>
  NextResponse.json(data, { status, headers: { "cache-control": "no-store" } });

export const clientIp = (request: NextRequest) =>
  request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
