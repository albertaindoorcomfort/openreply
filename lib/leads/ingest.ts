import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { Prisma, type Channel, type IdentityKind } from "@/app/generated/prisma/client";
import { normalizeIdentity } from "./normalize";
import { recordEvent, type Actor, type Tx } from "./timeline";
import { recordConsentTx, ConsentInputSchema, consentChannelFor } from "./consent";

const OPT_OUT = /^\s*(stop|stop all|unsubscribe|opt[ -]?out|cancel|end|quit)\s*[.!]?\s*$/i;
import { ensureDefaultPipeline } from "./pipeline";
import { LeadError } from "./errors";

const IDENTITY_KINDS = ["EMAIL", "PHONE", "INSTAGRAM", "MESSENGER", "WEB_VISITOR", "EXTERNAL"] as const;
const CHANNELS = ["WEB_FORM", "EMAIL", "INSTAGRAM", "MESSENGER", "SMS", "CALL", "VOICEMAIL", "CHAT"] as const;

/** Channels with a platform reply window after the customer's last message. */
const REPLY_WINDOW_MS: Partial<Record<Channel, number>> = {
  INSTAGRAM: 24 * 60 * 60 * 1000,
  MESSENGER: 24 * 60 * 60 * 1000,
};

/** The normalised inbound message every channel adapter posts. See docs/lead-model.md. */
export const InboundEventSchema = z
  .object({
    channel: z.enum(CHANNELS),
    channelAccountRef: z.string().min(1).max(200),
    externalThreadId: z.string().min(1).max(500),
    externalMessageId: z.string().min(1).max(500),
    occurredAt: z.coerce.date(),
    from: z
      .object({
        displayName: z.string().max(200).optional(),
        firstName: z.string().max(100).optional(),
        lastName: z.string().max(100).optional(),
        company: z.string().max(200).optional(),
        identities: z
          .array(z.object({ kind: z.enum(IDENTITY_KINDS), value: z.string().min(1).max(320) }).strict())
          .min(1)
          .max(10),
      })
      .strict(),
    subject: z.string().max(500).optional(),
    body: z.string().max(50_000),
    kind: z.enum(["MESSAGE", "VOICEMAIL", "TRANSCRIPT"]).default("MESSAGE"),
    attachments: z
      .array(z.object({ name: z.string().max(300), url: z.string().url().max(2000), contentType: z.string().max(200).optional() }).strict())
      .max(20)
      .default([]),
    consent: ConsentInputSchema.optional(),
    source: z
      .object({ detail: z.string().max(300).optional(), campaignRef: z.string().max(100).optional() })
      .strict()
      .optional(),
  })
  .strict();
export type InboundEvent = z.infer<typeof InboundEventSchema>;

export interface IngestResult {
  duplicate: boolean;
  contactId: string;
  conversationId: string;
  messageId: string;
  contactCreated: boolean;
  duplicateCandidates: string[];
}

/** Follows merges to the surviving contact. */
async function liveContactId(tx: Tx, contactId: string): Promise<string> {
  let id = contactId;
  for (let hops = 0; hops < 10; hops++) {
    const c = await tx.contact.findUnique({ where: { id }, select: { mergedIntoId: true } });
    if (!c?.mergedIntoId) return id;
    id = c.mergedIntoId;
  }
  return id;
}

/**
 * Turns one inbound message into canonical records: resolves or creates the
 * contact, finds or opens the conversation, and stores the message once.
 * Safe to call again with the same event; the second call changes nothing.
 */
export async function ingestInbound(actor: Actor, input: InboundEvent): Promise<IngestResult> {
  const event = InboundEventSchema.parse(input);
  assertCallIntakeOpen(event);
  const identities = dedupeIdentities(event.from.identities);
  if (identities.length === 0) throw new Error("INVALID_IDENTITIES");
  const pipeline = await ensureDefaultPipeline(actor.workspaceId);

  const run = () =>
    prisma.$transaction(
      async (tx) => {
        // Serialise concurrent ingests that touch the same person or thread, so
        // two messages arriving together cannot create two contacts.
        const lockKeys = [
          `thread:${event.channel}:${event.externalThreadId}`,
          ...identities.map((i) => `identity:${i.kind}:${i.value}`),
        ].sort();
        for (const key of lockKeys) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${actor.workspaceId + "|" + key}, 0))`;
        }
        return ingestTx(tx, actor, event, identities, pipeline.id);
      },
      { timeout: 15_000 }
    );

  try {
    return await run();
  } catch (err) {
    // A unique violation means a concurrent writer won a race we did not lock
    // (for example the same message id on a new thread). Re-running finds it.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return run();
    throw err;
  }
}

/**
 * Call records move to Reach's call store. RELAY_ACCEPT_CALL_INGEST=off refuses
 * new CALL and VOICEMAIL channel events and TRANSCRIPT messages; unset or "on"
 * keeps accepting them. Stored calls are never touched. SMS and social DMs
 * are not affected.
 */
export function assertCallIntakeOpen(event: Pick<InboundEvent, "channel" | "kind">) {
  if (process.env.RELAY_ACCEPT_CALL_INGEST?.trim().toLowerCase() !== "off") return;
  if (event.channel === "CALL" || event.channel === "VOICEMAIL" || event.kind === "TRANSCRIPT") {
    throw new LeadError("CALLS_MOVED", 410, "Calls, voicemails and transcripts are no longer stored here. Send them to Reach's call store.");
  }
}

function dedupeIdentities(raw: InboundEvent["from"]["identities"]) {
  const seen = new Map<string, { kind: IdentityKind; value: string }>();
  for (const i of raw) {
    const value = normalizeIdentity(i.kind, i.value);
    if (value) seen.set(`${i.kind}:${value}`, { kind: i.kind, value });
  }
  return [...seen.values()];
}

async function ingestTx(
  tx: Tx,
  actor: Actor,
  event: InboundEvent,
  identities: { kind: IdentityKind; value: string }[],
  pipelineId: string
): Promise<IngestResult> {
  const ws = actor.workspaceId;
  const existingConversation = await tx.conversation.findUnique({
    where: {
      workspaceId_channel_externalThreadId: { workspaceId: ws, channel: event.channel, externalThreadId: event.externalThreadId },
    },
  });

  if (existingConversation) {
    const dup = await tx.message.findUnique({
      where: {
        conversationId_externalMessageId: { conversationId: existingConversation.id, externalMessageId: event.externalMessageId },
      },
    });
    if (dup) {
      return {
        duplicate: true, contactId: existingConversation.contactId, conversationId: existingConversation.id,
        messageId: dup.id, contactCreated: false, duplicateCandidates: [],
      };
    }
  }

  // Identity resolution: the thread decides first, then any matching identity.
  const matches = await tx.contactIdentity.findMany({
    where: { workspaceId: ws, OR: identities.map((i) => ({ kind: i.kind, value: i.value })) },
    orderBy: { createdAt: "asc" },
  });
  const matchedContactIds: string[] = [];
  for (const m of matches) {
    const live = await liveContactId(tx, m.contactId);
    if (!matchedContactIds.includes(live)) matchedContactIds.push(live);
  }

  let contactId: string;
  let contactCreated = false;
  if (existingConversation) {
    contactId = await liveContactId(tx, existingConversation.contactId);
  } else if (matchedContactIds.length > 0) {
    // Oldest matching record wins; the others are flagged, never auto-merged.
    const oldest = await tx.contact.findFirst({
      where: { id: { in: matchedContactIds }, workspaceId: ws },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    contactId = oldest!.id;
  } else {
    const email = identities.find((i) => i.kind === "EMAIL")?.value ?? null;
    const phone = identities.find((i) => i.kind === "PHONE")?.value ?? null;
    const name =
      event.from.displayName?.trim() ||
      [event.from.firstName, event.from.lastName].filter(Boolean).join(" ") ||
      email ||
      phone ||
      identities[0].value;
    const contact = await tx.contact.create({
      data: {
        workspaceId: ws,
        displayName: name,
        firstName: event.from.firstName,
        lastName: event.from.lastName,
        company: event.from.company,
        primaryEmail: email,
        primaryPhone: phone,
        source: event.channel,
        sourceDetail: event.source?.detail,
        campaignRef: event.source?.campaignRef,
      },
    });
    contactId = contact.id;
    contactCreated = true;
    await recordEvent(tx, actor, {
      type: "contact.created", contactId, occurredAt: event.occurredAt,
      payload: { channel: event.channel, source: event.source ?? null },
    });
    await tx.opportunity.create({
      data: { workspaceId: ws, contactId, pipelineId, stageKey: "new", title: event.subject?.slice(0, 200) || `Inquiry from ${name}`, campaignRef: event.source?.campaignRef },
    }).then((opp) =>
      recordEvent(tx, actor, { type: "opportunity.created", contactId, opportunityId: opp.id, payload: { stageKey: "new" } })
    );
  }

  // Link identities that are new; flag ones that already belong to someone else.
  const duplicateCandidates: string[] = [];
  for (const identity of identities) {
    const owner = matches.find((m) => m.kind === identity.kind && m.value === identity.value);
    if (!owner) {
      await tx.contactIdentity.create({ data: { workspaceId: ws, contactId, ...identity, source: event.channel } });
      await recordEvent(tx, actor, { type: "identity.linked", contactId, payload: { kind: identity.kind } });
      continue;
    }
    const ownerLive = await liveContactId(tx, owner.contactId);
    if (ownerLive !== contactId) duplicateCandidates.push(ownerLive);
  }
  for (const other of new Set(duplicateCandidates)) {
    await flagDuplicate(tx, actor, contactId, other, "shared identity on one inbound message", 0.9);
  }

  const conversation =
    existingConversation ??
    (await tx.conversation.create({
      data: {
        workspaceId: ws,
        contactId,
        channel: event.channel,
        channelAccountRef: event.channelAccountRef,
        externalThreadId: event.externalThreadId,
        subject: event.subject,
      },
    }));
  if (!existingConversation) {
    await recordEvent(tx, actor, { type: "conversation.created", contactId, conversationId: conversation.id, payload: { channel: event.channel } });
  }

  const message = await tx.message.create({
    data: {
      workspaceId: ws,
      conversationId: conversation.id,
      contactId,
      direction: "INBOUND",
      kind: event.kind,
      authorKind: "CONTACT",
      authorId: contactId,
      body: event.body,
      attachments: event.attachments.length ? event.attachments : undefined,
      externalMessageId: event.externalMessageId,
      occurredAt: event.occurredAt,
    },
  });

  const windowMs = REPLY_WINDOW_MS[event.channel];
  const reopened = conversation.status === "CLOSED";
  await tx.conversation.update({
    where: { id: conversation.id },
    data: {
      status: "OPEN",
      unreadCount: { increment: 1 },
      version: { increment: 1 },
      lastInboundAt:
        !conversation.lastInboundAt || conversation.lastInboundAt < event.occurredAt ? event.occurredAt : undefined,
      replyWindowEndsAt: windowMs ? new Date(event.occurredAt.getTime() + windowMs) : undefined,
    },
  });
  if (reopened) await recordEvent(tx, actor, { type: "conversation.reopened", contactId, conversationId: conversation.id });

  // A draft written before this message no longer answers the customer.
  const staled = await tx.draft.updateMany({
    where: { conversationId: conversation.id, status: "PROPOSED" },
    data: { status: "STALE" },
  });
  if (staled.count > 0) {
    await recordEvent(tx, actor, { type: "draft.stale", contactId, conversationId: conversation.id, payload: { count: staled.count } });
  }

  await recordEvent(tx, actor, {
    type: event.kind === "VOICEMAIL" ? "voicemail.received" : "message.received",
    contactId,
    conversationId: conversation.id,
    occurredAt: event.occurredAt,
    payload: { messageId: message.id, channel: event.channel },
  });

  if (event.consent) await recordConsentTx(tx, actor, contactId, event.consent, event.occurredAt);
  // An opt-out keyword is a withdrawal on that channel, whatever an adapter says.
  const optOutChannel = consentChannelFor(event.channel);
  if (optOutChannel && OPT_OUT.test(event.body)) {
    await recordConsentTx(tx, actor, contactId, {
      channel: optOutChannel, basis: "EXPRESS", status: "WITHDRAWN", source: `opt-out keyword on ${event.channel}`,
      evidence: `message:${message.id}`,
    }, event.occurredAt);
  }

  return {
    duplicate: false, contactId, conversationId: conversation.id, messageId: message.id, contactCreated,
    duplicateCandidates: [...new Set(duplicateCandidates)],
  };
}

export async function flagDuplicate(tx: Tx, actor: Actor, a: string, b: string, reason: string, score: number) {
  const [contactId, otherContactId] = a < b ? [a, b] : [b, a];
  const existing = await tx.duplicateCandidate.findUnique({
    where: { workspaceId_contactId_otherContactId: { workspaceId: actor.workspaceId, contactId, otherContactId } },
  });
  if (existing) return existing;
  const created = await tx.duplicateCandidate.create({
    data: { workspaceId: actor.workspaceId, contactId, otherContactId, reason, score },
  });
  await recordEvent(tx, actor, { type: "duplicate.flagged", contactId, payload: { otherContactId, reason, score } });
  return created;
}
