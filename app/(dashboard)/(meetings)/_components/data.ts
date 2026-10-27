import { redirect } from "next/navigation";
import { getCurrentWorkspaceContext } from "@/lib/workspace-access";
import { findUserConnection } from "@/lib/microsoft/connection";

/** Session, workspace and the user's own Microsoft connection for a page. */
export async function pageContext() {
  const ctx = await getCurrentWorkspaceContext();
  if (!ctx) redirect("/login");
  const connection = await findUserConnection(ctx.workspaceId, ctx.userId);
  const timezone = connection?.timezone ?? "America/Edmonton";
  return { ctx, connection, timezone };
}

export const STATUS_STYLE: Record<string, string> = {
  SCHEDULED: "text-foreground",
  COMPLETED: "text-muted",
  CANCELLED: "text-muted line-through",
};
