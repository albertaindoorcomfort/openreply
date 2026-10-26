import { z } from "zod";
import { prisma } from "@/lib/db/client";
import type { AutomationMode, ConversationStatus, Prisma } from "@/app/generated/prisma/client";
import { LeadError, notFound, versionConflict } from "./errors";
import { recordEvent, type Actor } from "./timeline";
import { syncAutomationRule } from "./apollo";

export const COMPOSE_LOCK_MS = 2 * 60 * 1000;

async function load(actor: Actor, conversationId: string) {
  const c = await prisma.conversation.findFirst({ where: { id: conversationId, workspaceId: actor.workspaceId } });
  if (!c) throw notFound("Conversation");
  return c;
}

export interface InboxFilter {
  status?: ConversationStatus;
  mode?: AutomationMode;
  ownerUserId?: string;
  contactId?: string;
  q?: string;
  limit?: number;
}

export async function listConversations(actor: Actor, f: InboxFilter = {}) {
  const where: Prisma.ConversationWhereInput = {
    workspaceId: actor.workspaceId,
    ...(f.status ? { status: f.status } : {}),
    ...(f.mode ? { mode: f.mode } : {}),
    ...(f.ownerUserId ? { ownerUserId: f.ownerUserId } : {}),
    ...(f.contactId ? { contactId: f.contactId } : {}),
    ...(f.q
      ? {
          OR: [
            { subject: { contains: f.q, mode: "insensitive" } },
            { contact: { displayName: { contains: f.q, mode: "insensitive" } } },
            { contact: { primaryEmail: { contains: f.q, mode: "insensitive" } } },
            { contact: { primaryPhone: { contains: f.q } } },
            { messages: { some: { body: { contains: f.q, mode: "insensitive" } } } },
          ],
        }
      : {}),
  };
  const rows = await prisma.conversation.findMany({
    where,
    orderBy: [{ updatedAt: "desc" }],
    take: Math.min(f.limit ?? 50, 200),
    include: {
      contact: { select: { id: true, displayName: true, stageKey: true, leadScore: true, primaryEmail: true, primaryPhone: true } },
      messages: {
        where: { direction: { in: ["INBOUND", "OUTBOUND"] } },
        orderBy: { occurredAt: "desc" },
        take: 1,
        select: { id: true, body: true, direction: true, occurredAt: true },
      },
      drafts: { where: { status: "PROPOSED" }, select: { id: true }, take: 1 },
    },
  });
  const ids = rows.map((r) => r.id);
  const assessments = ids.length
    ? await prisma.assessment.findMany({
        where: { conversationId: { in: ids }, supersededAt: null },
        select: { conversationId: true, intent: true, urgency: true, summary: true },
      })
    : [];
  const byConv = new Map(assessments.map((a) => [a.conversationId, a]));
  return rows.map(({ messages, drafts, ...c }) => ({
    ...c,
    lastMessage: messages[0] ?? null,
    hasDraft: drafts.length > 0,
    assessment: byConv.get(c.id) ?? null,
  }));
}

/** The thread, including internal notes and coaching, which only staff see. */
export async function getConversation(actor: Actor, conversationId: string) {
  const c = await prisma.conversation.findFirst({
    where: { id: conversationId, workspaceId: actor.workspaceId },
    include: {
      contact: { include: { identities: true } },
      messages: { orderBy: [{ occurredAt: "asc" }, { createdAt: "asc" }], take: 500 },
      drafts: { where: { status: { in: ["PROPOSED", "SENDING", "FAILED", "SEND_UNCONFIRMED"] } }, orderBy: { createdAt: "desc" } },
      tasks: { where: { deletedAt: null, status: "OPEN" }, orderBy: { dueAt: "asc" } },
    },
  });
  if (!c) throw notFound("Conversation");
  const assessment = await prisma.assessment.findFirst({
    where: { conversationId, supersededAt: null },
    orderBy: { createdAt: "desc" },
  });
  return { ...c, assessment };
}

/** A person takes over: AIC OS stops, its open drafts are withdrawn. */
export async function takeOver(actor: Actor & { id: string }, conversationId: string) {
  await prisma.$transaction(async (tx) => {
    const c = await tx.conversation.findFirst({ where: { id: conversationId, workspaceId: actor.workspaceId } });
    if (!c) throw notFound("Conversation");
    await tx.conversation.update({
      where: { id: c.id },
      data: { mode: "HUMAN", ownerUserId: actor.id, version: { increment: 1 } },
    });
    const withdrawn = await tx.draft.updateMany({
      where: { conversationId: c.id, status: "PROPOSED", authorKind: "AGENT" },
      data: { status: "DISCARDED" },
    });
    await recordEvent(tx, actor, {
      type: "conversation.mode_changed", contactId: c.contactId, conversationId: c.id,
      payload: { from: c.mode, to: "HUMAN", withdrawnDrafts: withdrawn.count },
    });
  });
  await syncAutomationRule({ workspaceId: actor.workspaceId, conversationId, manual: true, actorUserId: actor.id });
}

/** Hand back to AIC OS (supervised), or set another mode. Autonomous is not available at launch. */
export async function setMode(actor: Actor, conversationId: string, mode: AutomationMode) {
  if (mode === "AUTONOMOUS") throw new LeadError("AUTONOMOUS_NOT_ENABLED", 403, "Autonomous sending is not enabled.");
  await prisma.$transaction(async (tx) => {
    const c = await tx.conversation.findFirst({ where: { id: conversationId, workspaceId: actor.workspaceId } });
    if (!c) throw notFound("Conversation");
    await tx.conversation.update({ where: { id: c.id }, data: { mode, version: { increment: 1 } } });
    await recordEvent(tx, actor, { type: "conversation.mode_changed", contactId: c.contactId, conversationId: c.id, payload: { from: c.mode, to: mode } });
  });
  await syncAutomationRule({
    workspaceId: actor.workspaceId, conversationId, manual: mode === "HUMAN" || mode === "MANUAL_ONLY",
    actorUserId: actor.kind === "USER" ? actor.id : null,
  });
}

/** AIC OS asks for a person: mode HUMAN and an urgent-enough task for the owner. */
export async function requestHandoff(actor: Actor, conversationId: string, input: { reason: string; priority?: "LOW" | "NORMAL" | "HIGH" | "URGENT" }) {
  const reason = z.string().trim().min(1).max(2000).parse(input.reason);
  const task = await prisma.$transaction(async (tx) => {
    const c = await tx.conversation.findFirst({ where: { id: conversationId, workspaceId: actor.workspaceId } });
    if (!c) throw notFound("Conversation");
    await tx.conversation.update({ where: { id: c.id }, data: { mode: "HUMAN", version: { increment: 1 } } });
    await tx.draft.updateMany({ where: { conversationId: c.id, status: "PROPOSED", authorKind: "AGENT" }, data: { status: "DISCARDED" } });
    const task = await tx.task.create({
      data: {
        workspaceId: actor.workspaceId, title: `Reply needed: ${reason.slice(0, 150)}`, notes: reason,
        priority: input.priority ?? "HIGH", contactId: c.contactId, conversationId: c.id,
        assigneeUserId: c.ownerUserId, createdByKind: actor.kind, createdById: actor.id, dueAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    await recordEvent(tx, actor, { type: "conversation.mode_changed", contactId: c.contactId, conversationId: c.id, payload: { from: c.mode, to: "HUMAN", handoff: true, reason } });
    await recordEvent(tx, actor, { type: "task.created", contactId: c.contactId, conversationId: c.id, taskId: task.id });
    return task;
  });
  await syncAutomationRule({ workspaceId: actor.workspaceId, conversationId, manual: true, actorUserId: null });
  return task;
}

/** Compose lock, so two people do not answer the same customer at once. Renew while typing. */
export async function acquireLock(actor: Actor & { id: string }, conversationId: string, now = new Date()) {
  const until = new Date(now.getTime() + COMPOSE_LOCK_MS);
  const res = await prisma.conversation.updateMany({
    where: {
      id: conversationId,
      workspaceId: actor.workspaceId,
      OR: [{ lockUserId: null }, { lockUserId: actor.id }, { lockExpiresAt: { lte: now } }],
    },
    data: { lockUserId: actor.id, lockExpiresAt: until },
  });
  if (res.count === 1) return { held: true as const, lockUserId: actor.id, lockExpiresAt: until };
  const c = await load(actor, conversationId);
  return { held: false as const, lockUserId: c.lockUserId, lockExpiresAt: c.lockExpiresAt };
}

export async function releaseLock(actor: Actor & { id: string }, conversationId: string) {
  await prisma.conversation.updateMany({
    where: { id: conversationId, workspaceId: actor.workspaceId, lockUserId: actor.id },
    data: { lockUserId: null, lockExpiresAt: null },
  });
}

export async function assign(actor: Actor, conversationId: string, ownerUserId: string | null, expectedVersion?: number) {
  return prisma.$transaction(async (tx) => {
    const c = await tx.conversation.findFirst({ where: { id: conversationId, workspaceId: actor.workspaceId } });
    if (!c) throw notFound("Conversation");
    if (ownerUserId) {
      const member = await tx.workspaceMember.findFirst({ where: { workspaceId: actor.workspaceId, userId: ownerUserId } });
      if (!member) throw new LeadError("NOT_A_MEMBER", 400, "The owner must be a member of this workspace.");
    }
    const res = await tx.conversation.updateMany({
      where: { id: c.id, ...(expectedVersion ? { version: expectedVersion } : {}) },
      data: { ownerUserId, version: { increment: 1 } },
    });
    if (res.count === 0) throw versionConflict();
    await recordEvent(tx, actor, { type: "conversation.assigned", contactId: c.contactId, conversationId: c.id, payload: { from: c.ownerUserId, to: ownerUserId } });
  });
}

export async function setStatus(actor: Actor, conversationId: string, status: ConversationStatus) {
  return prisma.$transaction(async (tx) => {
    const c = await tx.conversation.findFirst({ where: { id: conversationId, workspaceId: actor.workspaceId } });
    if (!c) throw notFound("Conversation");
    await tx.conversation.update({ where: { id: c.id }, data: { status, version: { increment: 1 } } });
    await recordEvent(tx, actor, {
      type: status === "CLOSED" ? "conversation.closed" : status === "OPEN" ? "conversation.reopened" : "conversation.snoozed",
      contactId: c.contactId, conversationId: c.id,
    });
  });
}

export async function markRead(actor: Actor, conversationId: string) {
  await prisma.conversation.updateMany({ where: { id: conversationId, workspaceId: actor.workspaceId }, data: { unreadCount: 0 } });
}

/**
 * Staff-only messages. A NOTE is for colleagues; COACHING is guidance for AIC OS
 * and is fed into its next draft. Neither is ever sent to the customer.
 */
export async function addInternal(actor: Actor, conversationId: string, kind: "NOTE" | "COACHING", body: string) {
  const text = z.string().trim().min(1).max(10_000).parse(body);
  return prisma.$transaction(async (tx) => {
    const c = await tx.conversation.findFirst({ where: { id: conversationId, workspaceId: actor.workspaceId } });
    if (!c) throw notFound("Conversation");
    const m = await tx.message.create({
      data: {
        workspaceId: actor.workspaceId, conversationId: c.id, contactId: c.contactId,
        direction: "INTERNAL", kind, authorKind: actor.kind, authorId: actor.id, body: text,
      },
    });
    await recordEvent(tx, actor, { type: kind === "COACHING" ? "coaching.added" : "note.added", contactId: c.contactId, conversationId: c.id, payload: { messageId: m.id } });
    return m;
  });
}
