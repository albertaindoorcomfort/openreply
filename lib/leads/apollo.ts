/**
 * Keeps Apollo's automation rule in step with a conversation's mode, so Apollo
 * refuses an agent's send before anyone is asked to approve it. Best effort:
 * Relay itself refuses sends in HUMAN mode, so a missed call cannot cause a send.
 */
export const conversationRef = (conversationId: string) => `aic:conversation:${conversationId}`;

export async function syncAutomationRule(input: {
  workspaceId: string;
  conversationId: string;
  manual: boolean;
  actorUserId: string | null;
}): Promise<"sent" | "skipped" | "failed"> {
  const base = process.env.APOLLO_URL;
  const token = process.env.APOLLO_SERVICE_TOKEN;
  if (!base || !token) return "skipped";
  const url = `${base.replace(/\/$/, "")}/v1/automation/contact`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        workspaceId: input.workspaceId,
        contactRef: conversationRef(input.conversationId),
        mode: input.manual ? "manual" : null,
        actorUserId: input.actorUserId,
      }),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}
