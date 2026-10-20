import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { Prisma, type Draft } from "@/app/generated/prisma/client";
import { LeadError, notFound } from "./errors";
import { sha256Hex, verifySendGrant } from "./grant";
import { canSend } from "./consent";
import { senderFor } from "./senders";
import { recordEvent, type Actor, type Tx } from "./timeline";

export const MAX_BODY = 5000;

export const ProposeDraftSchema = z
  .object({
    body: z.string().trim().min(1).max(MAX_BODY),
    rationale: z.string().max(4000).optional(),
    evidence: z
      .array(z.object({ kind: z.enum(["observation", "hypothesis", "inference"]), claim: z.string().max(2000), sourceRef: z.string().max(2000).nullable().default(null) }).strict())
      .max(20)
      .optional(),
    confidence: z.number().min(0).max(1).optional(),
    externalTaskId: z.string().max(100).optional(),
  })
  .strict();

async function latestCustomerVisibleMessage(tx: Tx, conversationId: string) {
  return tx.message.findFirst({
    where: { conversationId, direction: { in: ["INBOUND", "OUTBOUND"] } },
    orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
    select: { id: true, occurredAt: true },
  });
}

async function lockConversation(tx: Tx, conversationId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"conversation|" + conversationId}, 0))`;
}

/** Carla (or a person) proposes a reply. Never sends. */
export async function proposeDraft(actor: Actor, conversationId: string, input: z.input<typeof ProposeDraftSchema>) {
  const data = ProposeDraftSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    await lockConversation(tx, conversationId);
    const conversation = await tx.conversation.findFirst({ where: { id: conversationId, workspaceId: actor.workspaceId } });
    if (!conversation) throw notFound("Conversation");
    if (actor.kind === "AGENT" && (conversation.mode === "HUMAN" || conversation.mode === "MANUAL_ONLY")) {
      throw new LeadError("CARLA_PAUSED", 409, "A person has taken over this conversation.");
    }
    const basedOn = await latestCustomerVisibleMessage(tx, conversationId);
    // One live proposal per author kind: a newer one replaces the older.
    await tx.draft.updateMany({
      where: { conversationId, status: "PROPOSED", authorKind: actor.kind },
      data: { status: "DISCARDED" },
    });
    const draft = await tx.draft.create({
      data: {
        workspaceId: actor.workspaceId,
        conversationId,
        body: data.body,
        bodySha256: sha256Hex(data.body),
        authorKind: actor.kind,
        authorId: actor.id ?? "unknown",
        rationale: data.rationale,
        evidence: data.evidence,
        confidence: data.confidence,
        externalTaskId: data.externalTaskId,
        basedOnMessageId: basedOn?.id ?? null,
      },
    });
    await recordEvent(tx, actor, {
      type: "draft.proposed", contactId: conversation.contactId, conversationId,
      payload: { draftId: draft.id, confidence: data.confidence ?? null },
    });
    return draft;
  });
}

export interface SendResult {
  draftId: string;
  status: Draft["status"];
  messageId: string | null;
  error: string | null;
  /** True when this call found the draft already sent and did nothing. */
  replay: boolean;
}

interface Release {
  approvalId: string | null;
  approvedBy: string;
  /** Agent drafts stop when a person takes over; a person's own send does not. */
  agentInitiated: boolean;
}

/**
 * The only path from a draft to a customer. In order: the conversation is
 * locked; the draft must still be PROPOSED; Carla must not be paused; nothing
 * may have arrived or gone out since the draft was written; the channel's reply
 * window and the contact's consent must allow it; no other send may be in
 * flight. Then the draft is claimed (SENDING) and the approval id stored under
 * a unique index, so the same approval or click can never send twice.
 */
async function executeSend(actor: Actor, draftId: string, release: Release, now = new Date()): Promise<SendResult> {
  const claim = await prisma.$transaction(async (tx) => {
    const draft = await tx.draft.findFirst({ where: { id: draftId, workspaceId: actor.workspaceId } });
    if (!draft) throw notFound("Draft");
    await lockConversation(tx, draft.conversationId);
    const fresh = await tx.draft.findUniqueOrThrow({ where: { id: draftId } });
    if (fresh.status !== "PROPOSED") {
      if (fresh.status === "SENT" || fresh.status === "SENDING" || fresh.status === "SEND_UNCONFIRMED") {
        return { replay: true as const, draft: fresh };
      }
      throw new LeadError(`DRAFT_${fresh.status}`, 409, `This draft is ${fresh.status.toLowerCase()} and cannot be sent.`);
    }
    const conversation = await tx.conversation.findUniqueOrThrow({ where: { id: fresh.conversationId } });
    if (release.agentInitiated && (conversation.mode === "HUMAN" || conversation.mode === "MANUAL_ONLY")) {
      throw new LeadError("CARLA_PAUSED", 409, "A person has taken over this conversation.");
    }
    const latest = await latestCustomerVisibleMessage(tx, conversation.id);
    if (latest && latest.id !== fresh.basedOnMessageId) {
      await tx.draft.update({ where: { id: draftId }, data: { status: "STALE" } });
      await recordEvent(tx, actor, { type: "draft.stale", contactId: conversation.contactId, conversationId: conversation.id, payload: { draftId } });
      return { stale: true as const };
    }
    const inFlight = await tx.draft.count({ where: { conversationId: conversation.id, status: "SENDING" } });
    if (inFlight > 0) throw new LeadError("SEND_IN_PROGRESS", 409, "Another reply on this conversation is being sent.");
    if (conversation.replyWindowEndsAt && conversation.replyWindowEndsAt <= now) {
      throw new LeadError("REPLY_WINDOW_CLOSED", 409, "The channel no longer allows a reply to this conversation.");
    }
    const isReply = Boolean(conversation.lastInboundAt);
    const consent = await canSend(tx, conversation.contactId, conversation.channel, isReply, now);
    if (!consent.ok) throw new LeadError(consent.reason, 409);
    const sender = senderFor(conversation.channel);
    const unavailable = sender
      ? await sender.unavailableReason({ workspaceId: actor.workspaceId, channelAccountRef: conversation.channelAccountRef, contactId: conversation.contactId })
      : "CHANNEL_NOT_CONNECTED";
    if (unavailable) throw new LeadError(unavailable, 409, `Cannot send on ${conversation.channel}: ${unavailable}`);

    try {
      await tx.draft.update({
        where: { id: draftId },
        data: { status: "SENDING", approvalId: release.approvalId, approvedBy: release.approvedBy },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new LeadError("APPROVAL_ALREADY_USED", 409, "This approval has already released a message.");
      }
      throw err;
    }
    await recordEvent(tx, actor, {
      type: "draft.approved", contactId: conversation.contactId, conversationId: conversation.id,
      payload: { draftId, approvalId: release.approvalId, approvedBy: release.approvedBy },
    });
    const lastInbound = await tx.message.findFirst({
      where: { conversationId: conversation.id, direction: "INBOUND" },
      orderBy: { occurredAt: "desc" },
      select: { externalMessageId: true },
    });
    return { draft: fresh, conversation, inReplyTo: lastInbound?.externalMessageId ?? null };
  });

  if ("stale" in claim) {
    throw new LeadError("DRAFT_STALE", 409, "The conversation moved on after this draft was written. Draft a new reply.");
  }
  if ("replay" in claim) {
    return { draftId, status: claim.draft.status, messageId: claim.draft.sentMessageId, error: claim.draft.errorMessage, replay: true };
  }

  const { draft, conversation } = claim;
  const outcome = await senderFor(conversation.channel)!.send({
    workspaceId: actor.workspaceId,
    channel: conversation.channel,
    channelAccountRef: conversation.channelAccountRef,
    conversationId: conversation.id,
    contactId: conversation.contactId,
    subject: conversation.subject,
    body: draft.body,
    inReplyTo: claim.inReplyTo,
    idempotencyKey: draft.id,
  });

  return prisma.$transaction(async (tx) => {
    if (outcome.status === "sent") {
      const message = await tx.message.create({
        data: {
          workspaceId: actor.workspaceId,
          conversationId: conversation.id,
          contactId: conversation.contactId,
          direction: "OUTBOUND",
          authorKind: draft.authorKind,
          authorId: draft.authorId,
          body: draft.body,
          externalMessageId: outcome.externalMessageId ?? `draft:${draft.id}`,
          deliveryStatus: "sent",
        },
      });
      await tx.draft.update({ where: { id: draft.id }, data: { status: "SENT", sentMessageId: message.id } });
      await tx.conversation.update({
        where: { id: conversation.id },
        data: { lastOutboundAt: message.occurredAt, unreadCount: 0, version: { increment: 1 } },
      });
      // Anything else proposed against the old state no longer fits.
      await tx.draft.updateMany({ where: { conversationId: conversation.id, status: "PROPOSED" }, data: { status: "STALE" } });
      await recordEvent(tx, actor, {
        type: "message.sent", contactId: conversation.contactId, conversationId: conversation.id,
        payload: { draftId: draft.id, messageId: message.id, authorKind: draft.authorKind, approvalId: release.approvalId },
      });
      return { draftId: draft.id, status: "SENT" as const, messageId: message.id, error: null, replay: false };
    }
    const status = outcome.status === "rejected" ? ("FAILED" as const) : ("SEND_UNCONFIRMED" as const);
    await tx.draft.update({ where: { id: draft.id }, data: { status, errorMessage: outcome.error.slice(0, 2000) } });
    await recordEvent(tx, actor, {
      type: outcome.status === "rejected" ? "message.send_failed" : "message.send_unconfirmed",
      contactId: conversation.contactId, conversationId: conversation.id,
      payload: { draftId: draft.id, error: outcome.error.slice(0, 500) },
    });
    return { draftId: draft.id, status, messageId: null, error: outcome.error, replay: false };
  });
}

/**
 * Agent path: the control plane approved this exact text and signed a grant.
 * The grant must name this workspace, this draft and this text.
 */
export async function sendDraftWithGrant(actor: Actor, draftId: string, grant: string, now = new Date()) {
  const check = verifySendGrant(process.env.RELAY_GRANT_SECRET, grant, now.getTime());
  if (!check.ok) throw new LeadError(`GRANT_${check.reason}`, 403);
  const { claims } = check;
  if (claims.workspaceId !== actor.workspaceId) throw new LeadError("GRANT_WRONG_WORKSPACE", 403);
  if (claims.draftId !== draftId) throw new LeadError("GRANT_WRONG_DRAFT", 403);
  const draft = await prisma.draft.findFirst({ where: { id: draftId, workspaceId: actor.workspaceId } });
  if (!draft) throw notFound("Draft");
  if (draft.bodySha256 !== claims.textSha256) throw new LeadError("GRANT_TEXT_MISMATCH", 403, "The draft text differs from what was approved.");
  if (draft.approvalId && draft.approvalId !== claims.approvalId) throw new LeadError("APPROVAL_ALREADY_USED", 409);
  return executeSend(actor, draftId, { approvalId: claims.approvalId, approvedBy: claims.approvedBy, agentInitiated: true }, now);
}

export const HumanSendSchema = z
  .object({
    body: z.string().trim().min(1).max(MAX_BODY),
    /** Client-generated per click. A repeat returns the first result instead of sending again. */
    idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
    /** Set when the person is approving (and maybe editing) Carla's draft. */
    fromDraftId: z.string().max(100).optional(),
    /** The newest message the person saw. Refused if the thread moved on since. */
    basedOnMessageId: z.string().max(100).nullable(),
  })
  .strict();

/**
 * A signed-in person sends from the inbox. They must hold the compose lock (or
 * nobody does), and the click is idempotent.
 */
export async function sendAsUser(actor: Actor & { id: string }, conversationId: string, input: z.input<typeof HumanSendSchema>) {
  const data = HumanSendSchema.parse(input);
  const existing = await prisma.draft.findUnique({ where: { idempotencyKey: data.idempotencyKey } });
  if (existing) {
    if (existing.workspaceId !== actor.workspaceId) throw new LeadError("IDEMPOTENCY_KEY_REUSED", 409);
    return { draftId: existing.id, status: existing.status, messageId: existing.sentMessageId, error: existing.errorMessage, replay: true };
  }
  const draft = await prisma.$transaction(async (tx) => {
    await lockConversation(tx, conversationId);
    const conversation = await tx.conversation.findFirst({ where: { id: conversationId, workspaceId: actor.workspaceId } });
    if (!conversation) throw notFound("Conversation");
    if (conversation.lockUserId && conversation.lockUserId !== actor.id && conversation.lockExpiresAt && conversation.lockExpiresAt > new Date()) {
      throw new LeadError("LOCKED", 409, "Someone else is replying to this conversation.");
    }
    if (data.fromDraftId) {
      const source = await tx.draft.findFirst({ where: { id: data.fromDraftId, conversationId, status: "PROPOSED" } });
      if (!source) throw new LeadError("DRAFT_NOT_PROPOSED", 409, "That draft is no longer open.");
      await tx.draft.update({ where: { id: source.id }, data: { status: "DISCARDED" } });
      if (source.body !== data.body) {
        // An edit of Carla's draft is a correction worth learning from.
        await tx.feedback.create({
          data: {
            workspaceId: actor.workspaceId, targetKind: "DRAFT", targetId: source.id,
            original: { body: source.body }, corrected: { body: data.body }, userId: actor.id, conversationId,
            reason: "edited before sending",
          },
        });
        await recordEvent(tx, actor, { type: "feedback.recorded", contactId: conversation.contactId, conversationId, payload: { targetKind: "DRAFT", targetId: source.id } });
      }
    }
    return tx.draft.create({
      data: {
        workspaceId: actor.workspaceId,
        conversationId,
        body: data.body,
        bodySha256: sha256Hex(data.body),
        authorKind: data.fromDraftId ? "AGENT" : "USER",
        authorId: data.fromDraftId ? "carla" : actor.id,
        basedOnMessageId: data.basedOnMessageId,
        idempotencyKey: data.idempotencyKey,
      },
    });
  });
  return executeSend(actor, draft.id, { approvalId: null, approvedBy: actor.id, agentInitiated: false });
}

export async function discardDraft(actor: Actor, draftId: string) {
  return prisma.$transaction(async (tx) => {
    const draft = await tx.draft.findFirst({ where: { id: draftId, workspaceId: actor.workspaceId } });
    if (!draft) throw notFound("Draft");
    const res = await tx.draft.updateMany({ where: { id: draftId, status: "PROPOSED" }, data: { status: "DISCARDED" } });
    if (res.count === 0) throw new LeadError(`DRAFT_${draft.status}`, 409);
    await recordEvent(tx, actor, { type: "draft.discarded", conversationId: draft.conversationId, payload: { draftId } });
  });
}
