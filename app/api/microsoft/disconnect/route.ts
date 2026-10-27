import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getCurrentWorkspaceContext } from "@/lib/workspace-access";
import { findUserConnection, getGraphClientForConnection } from "@/lib/microsoft/connection";
import { removeConnectionSubscriptions } from "@/lib/microsoft/subscriptions";

/** Stops syncing and forgets the tokens. Meetings and notes already captured stay. */
export async function POST(request: NextRequest) {
  // Same-origin only: a cross-site form must not be able to disconnect a mailbox.
  const origin = request.headers.get("origin");
  if (!origin || new URL(origin).host !== request.nextUrl.host) {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }
  const context = await getCurrentWorkspaceContext();
  if (!context) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  const connection = await findUserConnection(context.workspaceId, context.userId);
  if (!connection) return NextResponse.json({ success: true });
  if (connection.status === "ACTIVE") {
    await removeConnectionSubscriptions(connection.id, getGraphClientForConnection(connection.id)).catch(() => undefined);
  }
  await prisma.microsoftConnection.update({
    where: { id: connection.id },
    data: { status: "DISCONNECTED", statusReason: "user", accessTokenEnc: "", refreshTokenEnc: "", calendarDeltaLink: null, mailDeltaLink: null },
  });
  return NextResponse.json({ success: true });
}
