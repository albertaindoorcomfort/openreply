import { createHmac } from "node:crypto";
import nodemailer from "nodemailer";
import { prisma } from "@/lib/db/client";
import type { Channel } from "@/app/generated/prisma/client";
import { createInstagramContext, sendDirectMessage } from "@/lib/instagram/provider";
import { classifySendError, isDeliveryUnconfirmed } from "@/lib/instagram/delivery-errors";

export interface OutboundRequest {
  workspaceId: string;
  channel: Channel;
  channelAccountRef: string;
  conversationId: string;
  contactId: string;
  subject: string | null;
  body: string;
  /** The customer's newest message id on this thread, for email threading. */
  inReplyTo: string | null;
  /** Stable per draft. Providers that accept one use it to drop repeats. */
  idempotencyKey: string;
}

export type SendOutcome =
  | { status: "sent"; externalMessageId: string | null }
  /** The provider said no. Nothing was delivered, so a person may retry. */
  | { status: "rejected"; error: string }
  /** We cannot tell. Never retried automatically: a person checks first. */
  | { status: "unconfirmed"; error: string };

export interface ChannelSender {
  /** Null when the channel can send for this workspace, otherwise why not. */
  unavailableReason(req: Pick<OutboundRequest, "workspaceId" | "channelAccountRef" | "contactId">): Promise<string | null>;
  send(req: OutboundRequest): Promise<SendOutcome>;
}

const instagramSender: ChannelSender = {
  async unavailableReason({ workspaceId, channelAccountRef, contactId }) {
    const account = await prisma.instagramAccount.findFirst({ where: { workspaceId, instagramId: channelAccountRef } });
    if (!account) return "INSTAGRAM_ACCOUNT_NOT_CONNECTED";
    const id = await prisma.contactIdentity.findFirst({ where: { contactId, kind: "INSTAGRAM" } });
    return id ? null : "NO_INSTAGRAM_IDENTITY";
  },
  async send(req) {
    const account = await prisma.instagramAccount.findFirst({ where: { workspaceId: req.workspaceId, instagramId: req.channelAccountRef } });
    const identity = await prisma.contactIdentity.findFirst({ where: { contactId: req.contactId, kind: "INSTAGRAM" } });
    if (!account || !identity) return { status: "rejected", error: "INSTAGRAM_ACCOUNT_NOT_CONNECTED" };
    try {
      const context = await createInstagramContext(account, req.idempotencyKey);
      const result = await sendDirectMessage({
        context,
        instagramAccountId: account.instagramId,
        userId: identity.value,
        message: req.body,
      });
      const mid = (result as { message_id?: string } | undefined)?.message_id ?? null;
      return { status: "sent", externalMessageId: mid };
    } catch (err) {
      const classified = classifySendError(err);
      const error = classified instanceof Error ? classified.message : String(classified);
      return isDeliveryUnconfirmed(classified) ? { status: "unconfirmed", error } : { status: "rejected", error };
    }
  },
};

/**
 * Email over SMTP, for replies to website forms and email leads until the
 * Outlook (Microsoft Graph) sender is connected. Configured by
 * LEADS_EMAIL_SERVER and LEADS_EMAIL_FROM.
 */
const smtpEmailSender: ChannelSender = {
  async unavailableReason({ contactId }) {
    if (!process.env.LEADS_EMAIL_SERVER || !process.env.LEADS_EMAIL_FROM) return "EMAIL_NOT_CONNECTED";
    const contact = await prisma.contact.findUnique({ where: { id: contactId }, select: { primaryEmail: true } });
    return contact?.primaryEmail ? null : "NO_EMAIL_ADDRESS";
  },
  async send(req) {
    const contact = await prisma.contact.findUnique({ where: { id: req.contactId }, select: { primaryEmail: true } });
    if (!contact?.primaryEmail) return { status: "rejected", error: "NO_EMAIL_ADDRESS" };
    const transport = nodemailer.createTransport(process.env.LEADS_EMAIL_SERVER);
    const subject = req.subject ? (/^re:/i.test(req.subject) ? req.subject : `Re: ${req.subject}`) : "Your inquiry";
    try {
      const info = await transport.sendMail({
        from: process.env.LEADS_EMAIL_FROM,
        to: contact.primaryEmail,
        subject,
        text: req.body,
        messageId: `<${req.idempotencyKey}@relay.local>`,
        ...(req.inReplyTo ? { inReplyTo: req.inReplyTo, references: [req.inReplyTo] } : {}),
      });
      return { status: "sent", externalMessageId: info.messageId ?? null };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      // SMTP 5xx is a definite refusal; anything else may have been accepted.
      const code = (err as { responseCode?: number }).responseCode;
      return code && code >= 500 && code < 600 ? { status: "rejected", error } : { status: "unconfirmed", error };
    }
  },
};

/**
 * SMS through the voice service (RingCentral). Signed like Apollo's module
 * calls (contracts.md section 3), with the draft id as the idempotency key so
 * a retry can never text the customer twice.
 */
const voiceServiceSmsSender: ChannelSender = {
  async unavailableReason({ contactId }) {
    if (!process.env.VOICE_SERVICE_URL || !process.env.RELAY_DELIVERY_SECRET) return "SMS_NOT_CONNECTED";
    const contact = await prisma.contact.findUnique({ where: { id: contactId }, select: { primaryPhone: true } });
    return contact?.primaryPhone ? null : "NO_PHONE_NUMBER";
  },
  async send(req) {
    const contact = await prisma.contact.findUnique({ where: { id: req.contactId }, select: { primaryPhone: true } });
    if (!contact?.primaryPhone) return { status: "rejected", error: "NO_PHONE_NUMBER" };
    const body = JSON.stringify({
      workspaceId: req.workspaceId,
      from: req.channelAccountRef,
      to: contact.primaryPhone,
      text: req.body,
      conversationRef: `aic:conversation:${req.conversationId}`,
      draftId: req.idempotencyKey,
    });
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = createHmac("sha256", process.env.RELAY_DELIVERY_SECRET!).update(`${ts}.${body}`).digest("hex");
    try {
      const res = await fetch(`${process.env.VOICE_SERVICE_URL!.replace(/\/$/, "")}/aic/deliver/sms`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-aic-timestamp": ts, "x-aic-signature": `v1=${sig}`, "idempotency-key": req.idempotencyKey },
        body,
        signal: AbortSignal.timeout(20_000),
      });
      const data = (await res.json().catch(() => ({}))) as { messageId?: string; error?: string; result?: { messageId?: string } };
      if (res.ok) return { status: "sent", externalMessageId: data.messageId ?? data.result?.messageId ?? null };
      // 409 means an earlier attempt with this draft id is still unresolved, not a refusal.
      if (res.status >= 400 && res.status < 500 && res.status !== 409 && res.status !== 429) {
        return { status: "rejected", error: data.error ?? `HTTP_${res.status}` };
      }
      return { status: "unconfirmed", error: data.error ?? `HTTP_${res.status}` };
    } catch (err) {
      return { status: "unconfirmed", error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const senders: Partial<Record<Channel, ChannelSender>> = {
  SMS: voiceServiceSmsSender,
  INSTAGRAM: instagramSender,
  EMAIL: smtpEmailSender,
  WEB_FORM: smtpEmailSender,
};

/** Other channel adapters (Outlook, RingCentral SMS) register here at startup. */
export function registerSender(channel: Channel, sender: ChannelSender) {
  senders[channel] = sender;
}

export function senderFor(channel: Channel): ChannelSender | null {
  return senders[channel] ?? null;
}
