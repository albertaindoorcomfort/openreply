import { after, NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getCurrentWorkspaceContext } from "@/lib/workspace-access";
import { getGraphClientForConnection, tokenFields } from "@/lib/microsoft/connection";
import { exchangeCode, MicrosoftTokenError, PKCE_COOKIE, readIdToken, verifyCallback } from "@/lib/microsoft/oauth";
import { startMailIngest, syncInbox } from "@/lib/microsoft/mail";
import { ensureCalendarSubscription } from "@/lib/microsoft/subscriptions";
import { relayFromEnv } from "@/lib/meetings/relay-client";
import { syncCalendar } from "@/lib/meetings/sync";

function back(request: NextRequest, status: string) {
  const response = NextResponse.redirect(new URL(`/meetings/connect?microsoft=${encodeURIComponent(status)}`, request.url));
  response.cookies.delete({ name: PKCE_COOKIE, path: "/api/microsoft/callback" });
  return response;
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  // Microsoft reports consent refusals here; only the code is passed on.
  if (params.get("error")) return back(request, params.get("error") === "access_denied" ? "denied" : "error");

  const verified = verifyCallback(params.get("state"), request.cookies.get(PKCE_COOKIE)?.value);
  const context = await getCurrentWorkspaceContext();
  // The flow must finish in the same browser session, workspace and user that started it.
  if (!verified || !context || context.userId !== verified.state.userId || context.workspaceId !== verified.state.workspaceId) {
    return back(request, "invalid_state");
  }
  const code = params.get("code");
  if (!code) return back(request, "error");

  let connectionId: string;
  try {
    const token = await exchangeCode(code, verified.verifier);
    if (!token.refresh_token) return back(request, "no_offline_access");
    const claims = readIdToken(token.id_token);
    const email = (claims.preferred_username ?? claims.email ?? "").toLowerCase();
    const owner = await prisma.microsoftConnection.findUnique({
      where: { workspaceId_msTenantId_msUserId: { workspaceId: context.workspaceId, msTenantId: claims.tid, msUserId: claims.oid } },
    });
    // One mailbox belongs to one person per workspace.
    if (owner && owner.userId !== context.userId) return back(request, "mailbox_in_use");

    const fields = tokenFields(token);
    const connection = await prisma.microsoftConnection.upsert({
      where: { workspaceId_userId: { workspaceId: context.workspaceId, userId: context.userId } },
      update: { ...fields, msTenantId: claims.tid, msUserId: claims.oid, email, displayName: claims.name ?? null, status: "ACTIVE", statusReason: null },
      create: {
        ...fields,
        grantedScopes: fields.grantedScopes ?? [],
        workspaceId: context.workspaceId,
        userId: context.userId,
        msTenantId: claims.tid,
        msUserId: claims.oid,
        email,
        displayName: claims.name ?? null,
      },
    });
    connectionId = connection.id;
  } catch (error) {
    if (error instanceof MicrosoftTokenError) return back(request, error.code === "wrong_tenant" ? "wrong_tenant" : "error");
    throw error;
  }

  // Subscribe and do the first sync after responding; the cron job retries either if it fails.
  after(async () => {
    const graph = getGraphClientForConnection(connectionId);
    await ensureCalendarSubscription(connectionId, graph).catch(() => undefined);
    await syncCalendar(connectionId, graph, relayFromEnv()).catch(() => undefined);
    // The service mailbox also starts feeding the lead inbox; any other mailbox is left alone.
    if (await startMailIngest(connectionId, graph).catch(() => false)) {
      await syncInbox(connectionId, { graph, relay: relayFromEnv() }).catch(() => undefined);
    }
  });
  return back(request, "connected");
}
