import { z } from "zod";
import type { Channel, ConsentChannel } from "@/app/generated/prisma/client";
import { recordEvent, type Actor, type Tx } from "./timeline";

export const ConsentInputSchema = z
  .object({
    channel: z.enum(["EMAIL", "SMS", "CALL", "DM"]),
    basis: z.enum(["EXPRESS", "IMPLIED"]),
    status: z.enum(["GRANTED", "WITHDRAWN"]).default("GRANTED"),
    source: z.string().min(1).max(300),
    evidence: z.string().max(2000).optional(),
  })
  .strict();
export type ConsentInput = z.input<typeof ConsentInputSchema>;

const DAY = 24 * 60 * 60 * 1000;
/**
 * CASL implied consent from an inquiry lasts 6 months. Express consent does not
 * expire until withdrawn. A purchase (2 years) is recorded by whoever closes the deal.
 */
const IMPLIED_INQUIRY_TTL_MS = 183 * DAY;

export async function recordConsentTx(tx: Tx, actor: Actor, contactId: string, input: ConsentInput, at = new Date()) {
  const c = ConsentInputSchema.parse(input);
  const row = await tx.consent.create({
    data: {
      workspaceId: actor.workspaceId,
      contactId,
      channel: c.channel,
      basis: c.basis,
      status: c.status,
      source: c.source,
      evidence: c.evidence,
      capturedAt: at,
      expiresAt: c.basis === "IMPLIED" && c.status === "GRANTED" ? new Date(at.getTime() + IMPLIED_INQUIRY_TTL_MS) : null,
      withdrawnAt: c.status === "WITHDRAWN" ? at : null,
    },
  });
  await recordEvent(tx, actor, {
    type: c.status === "WITHDRAWN" ? "consent.withdrawn" : "consent.recorded",
    contactId,
    payload: { channel: c.channel, basis: c.basis },
  });
  return row;
}

export const consentChannelFor = (channel: Channel): ConsentChannel | null =>
  channel === "EMAIL" || channel === "WEB_FORM" ? "EMAIL"
  : channel === "SMS" ? "SMS"
  : channel === "CALL" || channel === "VOICEMAIL" ? "CALL"
  : channel === "INSTAGRAM" || channel === "MESSENGER" || channel === "CHAT" ? "DM"
  : null;

export type ConsentDecision = { ok: true } | { ok: false; reason: "CONSENT_WITHDRAWN" | "CONSENT_EXPIRED" | "NO_CONSENT" };

/**
 * May we send on this channel? The newest record decides. A reply inside a
 * customer-started thread is allowed without a stored record, because the
 * customer's own message is the request being answered (CASL s.6(6) exempts
 * responses to inquiries), but never after an opt-out.
 */
export async function canSend(tx: Tx, contactId: string, channel: Channel, isReplyToInbound: boolean, now = new Date()): Promise<ConsentDecision> {
  const cc = consentChannelFor(channel);
  if (!cc) return { ok: true };
  const latest = await tx.consent.findFirst({
    where: { contactId, channel: cc },
    orderBy: { capturedAt: "desc" },
  });
  if (latest?.status === "WITHDRAWN") return { ok: false, reason: "CONSENT_WITHDRAWN" };
  if (isReplyToInbound) return { ok: true };
  if (!latest) return { ok: false, reason: "NO_CONSENT" };
  if (latest.expiresAt && latest.expiresAt <= now) return { ok: false, reason: "CONSENT_EXPIRED" };
  return { ok: true };
}
