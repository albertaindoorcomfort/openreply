import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getCurrentWorkspaceContext } from "@/lib/workspace-access";
import { findUserConnection, getGraphClientForConnection } from "@/lib/microsoft/connection";
import { removeConnectionSubscriptions } from "@/lib/microsoft/subscriptions";

/** Stops syncing and forgets the tokens. Meetings and notes already captured stay. */
export async function POST() {
  const context = await getCurrentWorkspaceContext();
  if (!context) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  const connection = await findUserConnection(context.workspaceId, context.userId);
  if (!connection) return NextResponse.json({ success: true });
  if (connection.status === "ACTIVE") {
    await removeConnectionSubscriptions(connection.id, getGraphClientForConnection(connection.id)).catch(() => undefined);
  }
  await prisma.microsoftConnection.update({
    where: { id: connection.id },
    data: { status: "DISCONNECTED", statusReason: "user", accessTokenEnc: "", refreshTokenEnc: "", calendarDeltaLink: null },
  });
  return NextResponse.json({ success: true });
}
