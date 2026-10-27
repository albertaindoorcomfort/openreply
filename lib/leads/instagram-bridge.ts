import { ingestInbound } from "./ingest";
import { enqueueCarla } from "./queue";

/**
 * Copies an inbound Instagram DM into the lead inbox. Runs beside the keyword
 * automations, never instead of them, and a failure here never blocks them.
 */
export async function bridgeInstagramDm(input: {
  workspaceId: string;
  instagramAccountId: string;
  senderId: string;
  messageId: string;
  text: string;
  occurredAt?: Date;
}) {
  if (process.env.LEADS_INSTAGRAM_BRIDGE === "off") return null;
  try {
    const result = await ingestInbound(
      { kind: "SYSTEM", id: "instagram-webhook", workspaceId: input.workspaceId },
      {
        channel: "INSTAGRAM",
        channelAccountRef: input.instagramAccountId,
        externalThreadId: `${input.instagramAccountId}:${input.senderId}`,
        externalMessageId: input.messageId,
        occurredAt: input.occurredAt ?? new Date(),
        from: { displayName: `Instagram ${input.senderId}`, identities: [{ kind: "INSTAGRAM", value: input.senderId }] },
        body: input.text,
        kind: "MESSAGE",
        attachments: [],
      }
    );
    if (!result.duplicate) {
      await enqueueCarla({ workspaceId: input.workspaceId, conversationId: result.conversationId, messageId: result.messageId });
    }
    return result;
  } catch (err) {
    console.error("[Leads] Instagram DM bridge failed:", err instanceof Error ? err.message : err);
    return null;
  }
}
