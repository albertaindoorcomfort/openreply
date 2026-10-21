import { prisma } from "@/lib/db/client";
import { findConnectionByEmail, getGraphClientForConnection } from "@/lib/microsoft/connection";
import { GraphError, type GraphClient } from "@/lib/microsoft/graph";
import type { ChannelSender, OutboundRequest, SendOutcome } from "./senders";

/**
 * Email through a connected Outlook mailbox (Microsoft Graph, delegated
 * Mail.Send). The mailbox is the conversation's own address when it is
 * connected, otherwise LEADS_OUTLOOK_MAILBOX (replies to website forms).
 *
 * Graph sends in two steps: create a draft, then send it. Only the second
 * step can deliver, so a failure before it is a plain rejection and one
 * during it is unconfirmed unless Graph refused the request outright.
 */

const looksLikeEmail = (v: string) => /^[^\s@]+@[^\s@]+$/.test(v);

async function outlookConnection(workspaceId: string, channelAccountRef: string) {
  const candidates = [channelAccountRef, process.env.LEADS_OUTLOOK_MAILBOX ?? ""].filter(looksLikeEmail);
  for (const email of candidates) {
    const c = await findConnectionByEmail(workspaceId, email);
    if (c && c.grantedScopes.some((s) => s.toLowerCase() === "mail.send")) return c;
  }
  return null;
}

/** True when this conversation's email would go out through Outlook. */
export async function hasOutlookMailbox(workspaceId: string, channelAccountRef: string) {
  return (await outlookConnection(workspaceId, channelAccountRef)) !== null;
}

type DraftMessage = { id: string; internetMessageId?: string };

async function createOutlookDraft(graph: GraphClient, req: OutboundRequest, to: string): Promise<DraftMessage> {
  const body = { contentType: "Text", content: req.body };
  if (req.inReplyTo) {
    // Reply inside the customer's thread when their message is in this mailbox.
    const filter = encodeURIComponent(`internetMessageId eq '${req.inReplyTo.replaceAll("'", "''")}'`);
    const found = await graph.request<{ value: { id: string }[] }>(`/me/messages?$filter=${filter}&$select=id&$top=1`);
    const original = found.value[0];
    if (original) {
      const draft = await graph.request<DraftMessage>(`/me/messages/${encodeURIComponent(original.id)}/createReply`, {
        method: "POST",
        body: JSON.stringify({ message: { body, toRecipients: [{ emailAddress: { address: to } }] } }),
      });
      return draft;
    }
  }
  const subject = req.subject ? (/^re:/i.test(req.subject) ? req.subject : `Re: ${req.subject}`) : "Your inquiry";
  return graph.request<DraftMessage>("/me/messages", {
    method: "POST",
    body: JSON.stringify({ subject, body, toRecipients: [{ emailAddress: { address: to } }] }),
  });
}

/** Graph refused the send itself, so nothing went out. Anything else may have. */
const refusedOutright = (err: unknown) => err instanceof GraphError && [400, 401, 403, 413].includes(err.status);

export function outlookEmailSender(graphFor: (connectionId: string) => GraphClient = getGraphClientForConnection): ChannelSender {
  return {
    async unavailableReason({ workspaceId, channelAccountRef, contactId }) {
      if (!(await outlookConnection(workspaceId, channelAccountRef))) return "OUTLOOK_NOT_CONNECTED";
      const contact = await prisma.contact.findUnique({ where: { id: contactId }, select: { primaryEmail: true } });
      return contact?.primaryEmail ? null : "NO_EMAIL_ADDRESS";
    },
    async send(req): Promise<SendOutcome> {
      const connection = await outlookConnection(req.workspaceId, req.channelAccountRef);
      const contact = await prisma.contact.findUnique({ where: { id: req.contactId }, select: { primaryEmail: true } });
      if (!connection) return { status: "rejected", error: "OUTLOOK_NOT_CONNECTED" };
      if (!contact?.primaryEmail) return { status: "rejected", error: "NO_EMAIL_ADDRESS" };
      const graph = graphFor(connection.id);

      let draft: DraftMessage;
      try {
        draft = await createOutlookDraft(graph, req, contact.primaryEmail);
        if (!draft.internetMessageId) {
          draft = await graph.request<DraftMessage>(`/me/messages/${encodeURIComponent(draft.id)}?$select=id,internetMessageId`);
        }
      } catch (err) {
        return { status: "rejected", error: err instanceof Error ? err.message : String(err) };
      }

      try {
        await graph.sendDraft(draft.id);
        return { status: "sent", externalMessageId: draft.internetMessageId ?? null };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        if (!refusedOutright(err)) return { status: "unconfirmed", error };
        // Leave no stray draft behind for the next attempt.
        await graph.request(`/me/messages/${encodeURIComponent(draft.id)}`, { method: "DELETE" }).catch(() => undefined);
        return { status: "rejected", error };
      }
    },
  };
}
