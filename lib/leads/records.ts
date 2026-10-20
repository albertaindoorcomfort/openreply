import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { Prisma } from "@/app/generated/prisma/client";
import { LeadError, notFound, versionConflict } from "./errors";
import { ensureDefaultPipeline } from "./pipeline";
import { recordEvent, type Actor } from "./timeline";

// ── Contacts ────────────────────────────────────────────────────────────────

export async function listContacts(actor: Actor, opts: { q?: string; stageKey?: string; includeDeleted?: boolean; limit?: number } = {}) {
  return prisma.contact.findMany({
    where: {
      workspaceId: actor.workspaceId,
      mergedIntoId: null,
      ...(opts.includeDeleted ? {} : { deletedAt: null }),
      ...(opts.stageKey ? { stageKey: opts.stageKey } : {}),
      ...(opts.q
        ? {
            OR: [
              { displayName: { contains: opts.q, mode: "insensitive" } },
              { company: { contains: opts.q, mode: "insensitive" } },
              { identities: { some: { value: { contains: opts.q.toLowerCase() } } } },
            ],
          }
        : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: Math.min(opts.limit ?? 50, 200),
  });
}

/** Everything known about one lead, for the profile and Carla's context. */
export async function getContactProfile(actor: Actor, contactId: string) {
  const contact = await prisma.contact.findFirst({
    where: { id: contactId, workspaceId: actor.workspaceId },
    include: {
      identities: true,
      consents: { orderBy: { capturedAt: "desc" } },
      conversations: { orderBy: { updatedAt: "desc" }, take: 50 },
      tasks: { where: { deletedAt: null }, orderBy: [{ status: "asc" }, { dueAt: "asc" }], take: 100 },
      opportunities: { where: { deletedAt: null }, orderBy: { createdAt: "desc" } },
    },
  });
  if (!contact) throw notFound("Contact");
  const [timeline, duplicates] = await Promise.all([
    prisma.timelineEvent.findMany({ where: { workspaceId: actor.workspaceId, contactId }, orderBy: { seq: "desc" }, take: 200 }),
    prisma.duplicateCandidate.findMany({
      where: { workspaceId: actor.workspaceId, status: "OPEN", OR: [{ contactId }, { otherContactId: contactId }] },
    }),
  ]);
  return { ...contact, timeline: timeline.map((e) => ({ ...e, seq: e.seq.toString() })), duplicates };
}

export const ContactPatchSchema = z
  .object({
    version: z.number().int().positive(),
    displayName: z.string().trim().min(1).max(200).optional(),
    firstName: z.string().max(100).nullable().optional(),
    lastName: z.string().max(100).nullable().optional(),
    company: z.string().max(200).nullable().optional(),
    ownerUserId: z.string().max(100).nullable().optional(),
    stageKey: z.string().max(50).optional(),
    leadScore: z.number().int().min(0).max(100).nullable().optional(),
  })
  .strict();

export async function updateContact(actor: Actor, contactId: string, input: z.input<typeof ContactPatchSchema>) {
  const { version, ...patch } = ContactPatchSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const before = await tx.contact.findFirst({ where: { id: contactId, workspaceId: actor.workspaceId, deletedAt: null } });
    if (!before) throw notFound("Contact");
    if (patch.stageKey) {
      const pipeline = await ensureDefaultPipeline(actor.workspaceId);
      if (!pipeline.stages.some((s) => s.key === patch.stageKey)) throw new LeadError("UNKNOWN_STAGE", 400);
    }
    if (patch.ownerUserId) {
      const member = await tx.workspaceMember.findFirst({ where: { workspaceId: actor.workspaceId, userId: patch.ownerUserId } });
      if (!member) throw new LeadError("NOT_A_MEMBER", 400);
    }
    const res = await tx.contact.updateMany({ where: { id: contactId, version }, data: { ...patch, version: { increment: 1 } } });
    if (res.count === 0) throw versionConflict();
    const changed = Object.fromEntries(
      Object.entries(patch).map(([k, v]) => [k, { from: (before as Record<string, unknown>)[k] ?? null, to: v ?? null }])
    );
    await recordEvent(tx, actor, { type: "contact.updated", contactId, payload: changed as Prisma.InputJsonValue });
    return tx.contact.findUniqueOrThrow({ where: { id: contactId } });
  });
}

export async function setContactDeleted(actor: Actor, contactId: string, deleted: boolean) {
  return prisma.$transaction(async (tx) => {
    const c = await tx.contact.findFirst({ where: { id: contactId, workspaceId: actor.workspaceId } });
    if (!c) throw notFound("Contact");
    await tx.contact.update({ where: { id: contactId }, data: { deletedAt: deleted ? new Date() : null, version: { increment: 1 } } });
    await recordEvent(tx, actor, { type: deleted ? "contact.deleted" : "contact.restored", contactId });
  });
}

/**
 * Merges `fromId` into `intoId`: identities, conversations, tasks, consent and
 * opportunities move; the merged contact stays (with mergedIntoId) so the
 * history is never lost and adapters that still hold the old id resolve.
 */
export async function mergeContacts(actor: Actor, intoId: string, fromId: string) {
  if (intoId === fromId) throw new LeadError("SAME_CONTACT", 400);
  return prisma.$transaction(async (tx) => {
    const [into, from] = await Promise.all([
      tx.contact.findFirst({ where: { id: intoId, workspaceId: actor.workspaceId, mergedIntoId: null } }),
      tx.contact.findFirst({ where: { id: fromId, workspaceId: actor.workspaceId, mergedIntoId: null } }),
    ]);
    if (!into || !from) throw notFound("Contact");
    await tx.contactIdentity.updateMany({ where: { contactId: fromId }, data: { contactId: intoId } });
    await tx.conversation.updateMany({ where: { contactId: fromId }, data: { contactId: intoId } });
    await tx.message.updateMany({ where: { contactId: fromId }, data: { contactId: intoId } });
    await tx.task.updateMany({ where: { contactId: fromId }, data: { contactId: intoId } });
    await tx.consent.updateMany({ where: { contactId: fromId }, data: { contactId: intoId } });
    await tx.opportunity.updateMany({ where: { contactId: fromId }, data: { contactId: intoId } });
    await tx.contact.update({
      where: { id: intoId },
      data: {
        primaryEmail: into.primaryEmail ?? from.primaryEmail,
        primaryPhone: into.primaryPhone ?? from.primaryPhone,
        company: into.company ?? from.company,
        version: { increment: 1 },
      },
    });
    await tx.contact.update({ where: { id: fromId }, data: { mergedIntoId: intoId, version: { increment: 1 } } });
    const [a, b] = intoId < fromId ? [intoId, fromId] : [fromId, intoId];
    await tx.duplicateCandidate.updateMany({
      where: { workspaceId: actor.workspaceId, contactId: a, otherContactId: b },
      data: { status: "MERGED", resolvedBy: actor.id, resolvedAt: new Date() },
    });
    await recordEvent(tx, actor, { type: "contact.merged", contactId: intoId, payload: { mergedContactId: fromId } });
  });
}

export async function dismissDuplicate(actor: Actor, candidateId: string) {
  const res = await prisma.duplicateCandidate.updateMany({
    where: { id: candidateId, workspaceId: actor.workspaceId, status: "OPEN" },
    data: { status: "DISMISSED", resolvedBy: actor.id, resolvedAt: new Date() },
  });
  if (res.count === 0) throw notFound("Duplicate candidate");
}

// ── Tasks ───────────────────────────────────────────────────────────────────

const PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;

export const TaskCreateSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    notes: z.string().max(10_000).optional(),
    dueAt: z.coerce.date().optional(),
    remindAt: z.coerce.date().optional(),
    priority: z.enum(PRIORITIES).default("NORMAL"),
    contactId: z.string().max(100).optional(),
    conversationId: z.string().max(100).optional(),
    opportunityId: z.string().max(100).optional(),
    assigneeUserId: z.string().max(100).optional(),
    assigneeAgentId: z.string().max(64).optional(),
  })
  .strict();

async function assertLinks(actor: Actor, links: { contactId?: string; conversationId?: string; opportunityId?: string; assigneeUserId?: string }) {
  const ws = actor.workspaceId;
  const checks = await Promise.all([
    links.contactId ? prisma.contact.count({ where: { id: links.contactId, workspaceId: ws } }) : 1,
    links.conversationId ? prisma.conversation.count({ where: { id: links.conversationId, workspaceId: ws } }) : 1,
    links.opportunityId ? prisma.opportunity.count({ where: { id: links.opportunityId, workspaceId: ws } }) : 1,
    links.assigneeUserId ? prisma.workspaceMember.count({ where: { userId: links.assigneeUserId, workspaceId: ws } }) : 1,
  ]);
  if (checks.some((n) => n === 0)) throw new LeadError("INVALID_LINK", 400, "A linked record is not in this workspace.");
}

export async function createTask(actor: Actor, input: z.input<typeof TaskCreateSchema>) {
  const data = TaskCreateSchema.parse(input);
  await assertLinks(actor, data);
  let contactId = data.contactId;
  if (!contactId && data.conversationId) {
    contactId = (await prisma.conversation.findUnique({ where: { id: data.conversationId }, select: { contactId: true } }))?.contactId;
  }
  return prisma.$transaction(async (tx) => {
    const task = await tx.task.create({
      data: { ...data, contactId, workspaceId: actor.workspaceId, createdByKind: actor.kind, createdById: actor.id },
    });
    await recordEvent(tx, actor, {
      type: "task.created", taskId: task.id, contactId: task.contactId, conversationId: task.conversationId, opportunityId: task.opportunityId,
      payload: { title: task.title, dueAt: task.dueAt?.toISOString() ?? null },
    });
    return task;
  });
}

export const TaskPatchSchema = z
  .object({
    version: z.number().int().positive(),
    title: z.string().trim().min(1).max(300).optional(),
    notes: z.string().max(10_000).nullable().optional(),
    dueAt: z.coerce.date().nullable().optional(),
    remindAt: z.coerce.date().nullable().optional(),
    priority: z.enum(PRIORITIES).optional(),
    status: z.enum(["OPEN", "DONE", "CANCELLED"]).optional(),
    assigneeUserId: z.string().max(100).nullable().optional(),
    deleted: z.boolean().optional(),
  })
  .strict();

export async function updateTask(actor: Actor, taskId: string, input: z.input<typeof TaskPatchSchema>) {
  const { version, deleted, ...patch } = TaskPatchSchema.parse(input);
  if (patch.assigneeUserId) await assertLinks(actor, { assigneeUserId: patch.assigneeUserId });
  return prisma.$transaction(async (tx) => {
    const before = await tx.task.findFirst({ where: { id: taskId, workspaceId: actor.workspaceId } });
    if (!before) throw notFound("Task");
    const res = await tx.task.updateMany({
      where: { id: taskId, version },
      data: {
        ...patch,
        ...(patch.status === "DONE" && before.status !== "DONE" ? { completedAt: new Date() } : {}),
        ...(patch.status && patch.status !== "DONE" ? { completedAt: null } : {}),
        ...(deleted === undefined ? {} : { deletedAt: deleted ? new Date() : null }),
        version: { increment: 1 },
      },
    });
    if (res.count === 0) throw versionConflict();
    await recordEvent(tx, actor, {
      type: patch.status === "DONE" && before.status !== "DONE" ? "task.completed" : "task.updated",
      taskId, contactId: before.contactId, conversationId: before.conversationId, opportunityId: before.opportunityId,
      payload: { ...patch, deleted, dueAt: patch.dueAt?.toISOString() ?? undefined, remindAt: patch.remindAt?.toISOString() ?? undefined } as Prisma.InputJsonValue,
    });
    return tx.task.findUniqueOrThrow({ where: { id: taskId } });
  });
}

export async function listTasks(actor: Actor, opts: { assigneeUserId?: string; status?: "OPEN" | "DONE" | "CANCELLED"; dueBefore?: Date; contactId?: string } = {}) {
  return prisma.task.findMany({
    where: {
      workspaceId: actor.workspaceId,
      deletedAt: null,
      status: opts.status ?? "OPEN",
      ...(opts.assigneeUserId ? { assigneeUserId: opts.assigneeUserId } : {}),
      ...(opts.contactId ? { contactId: opts.contactId } : {}),
      ...(opts.dueBefore ? { dueAt: { lte: opts.dueBefore } } : {}),
    },
    orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }, { priority: "desc" }],
    take: 300,
    include: { contact: { select: { id: true, displayName: true } } },
  });
}

// ── Opportunities and pipeline ──────────────────────────────────────────────

export async function getBoard(actor: Actor) {
  const pipeline = await ensureDefaultPipeline(actor.workspaceId);
  const opps = await prisma.opportunity.findMany({
    where: { workspaceId: actor.workspaceId, pipelineId: pipeline.id, deletedAt: null },
    orderBy: { updatedAt: "desc" },
    take: 1000,
    include: { contact: { select: { id: true, displayName: true, leadScore: true } } },
  });
  return { pipeline, opportunities: opps };
}

export const OpportunityPatchSchema = z
  .object({
    version: z.number().int().positive(),
    stageKey: z.string().max(50).optional(),
    title: z.string().trim().min(1).max(300).optional(),
    valueCents: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
    ownerUserId: z.string().max(100).nullable().optional(),
    expectedCloseAt: z.coerce.date().nullable().optional(),
    lostReason: z.string().max(1000).nullable().optional(),
  })
  .strict();

export async function updateOpportunity(actor: Actor, opportunityId: string, input: z.input<typeof OpportunityPatchSchema>) {
  const { version, ...patch } = OpportunityPatchSchema.parse(input);
  if (patch.ownerUserId) await assertLinks(actor, { assigneeUserId: patch.ownerUserId });
  return prisma.$transaction(async (tx) => {
    const before = await tx.opportunity.findFirst({
      where: { id: opportunityId, workspaceId: actor.workspaceId, deletedAt: null },
      include: { pipeline: { include: { stages: true } } },
    });
    if (!before) throw notFound("Opportunity");
    let outcome = before.outcome;
    let closedAt = before.closedAt;
    if (patch.stageKey) {
      const stage = before.pipeline.stages.find((s) => s.key === patch.stageKey);
      if (!stage) throw new LeadError("UNKNOWN_STAGE", 400);
      outcome = stage.kind;
      closedAt = stage.kind === "OPEN" ? null : (before.closedAt ?? new Date());
    }
    const res = await tx.opportunity.updateMany({
      where: { id: opportunityId, version },
      data: { ...patch, outcome, closedAt, version: { increment: 1 } },
    });
    if (res.count === 0) throw versionConflict();
    if (patch.stageKey && patch.stageKey !== before.stageKey) {
      // The contact's lifecycle stage follows its newest opportunity.
      await tx.contact.update({ where: { id: before.contactId }, data: { stageKey: patch.stageKey, version: { increment: 1 } } });
      await recordEvent(tx, actor, {
        type: outcome === "WON" ? "opportunity.won" : outcome === "LOST" ? "opportunity.lost" : "opportunity.stage_changed",
        contactId: before.contactId, opportunityId,
        payload: { from: before.stageKey, to: patch.stageKey, valueCents: patch.valueCents ?? before.valueCents },
      });
    }
    const rest = { ...patch, stageKey: undefined };
    if (Object.values(rest).some((v) => v !== undefined)) {
      await recordEvent(tx, actor, {
        type: "opportunity.updated", contactId: before.contactId, opportunityId,
        payload: { ...rest, expectedCloseAt: rest.expectedCloseAt?.toISOString() ?? undefined } as Prisma.InputJsonValue,
      });
    }
    return tx.opportunity.findUniqueOrThrow({ where: { id: opportunityId } });
  });
}

// ── Timeline written by other modules, and the change feed ──────────────────

export const ExternalTimelineSchema = z
  .object({
    type: z.string().regex(/^(meeting|call|voicemail|calendar)\.[a-z_]{1,40}$/),
    contactId: z.string().max(100).optional(),
    conversationId: z.string().max(100).optional(),
    opportunityId: z.string().max(100).optional(),
    occurredAt: z.coerce.date().optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
    idempotencyKey: z.string().min(1).max(200).optional(),
  })
  .strict()
  .refine((v) => v.contactId || v.conversationId || v.opportunityId, "link at least one record");

export async function writeExternalEvent(actor: Actor, input: z.input<typeof ExternalTimelineSchema>) {
  const data = ExternalTimelineSchema.parse(input);
  if (JSON.stringify(data.payload ?? {}).length > 20_000) throw new LeadError("PAYLOAD_TOO_LARGE", 413);
  await assertLinks(actor, data);
  if (data.idempotencyKey) {
    const existing = await prisma.timelineEvent.findUnique({
      where: { workspaceId_idempotencyKey: { workspaceId: actor.workspaceId, idempotencyKey: data.idempotencyKey } },
    });
    if (existing) return { id: existing.id, duplicate: true };
  }
  try {
    const event = await prisma.timelineEvent.create({
      data: {
        workspaceId: actor.workspaceId, actorKind: actor.kind, actorId: actor.id, type: data.type,
        contactId: data.contactId, conversationId: data.conversationId, opportunityId: data.opportunityId,
        occurredAt: data.occurredAt, payload: data.payload as Prisma.InputJsonValue | undefined, idempotencyKey: data.idempotencyKey,
      },
    });
    return { id: event.id, duplicate: false };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002" && data.idempotencyKey) {
      const existing = await prisma.timelineEvent.findUniqueOrThrow({
        where: { workspaceId_idempotencyKey: { workspaceId: actor.workspaceId, idempotencyKey: data.idempotencyKey } },
      });
      return { id: existing.id, duplicate: true };
    }
    throw err;
  }
}

/** Ordered change feed for Apollo, Trigr and Compass. `after` is the last seq seen. */
export async function listChanges(actor: Actor, after: bigint, limit = 200) {
  const rows = await prisma.timelineEvent.findMany({
    // Events younger than a few seconds are held back: a sequence number is
    // taken at insert, so a slower transaction can commit a lower one late.
    where: { workspaceId: actor.workspaceId, seq: { gt: after }, createdAt: { lt: new Date(Date.now() - 5000) } },
    orderBy: { seq: "asc" },
    take: Math.min(limit, 500),
  });
  return {
    events: rows.map((e) => ({ ...e, seq: e.seq.toString() })),
    cursor: rows.length ? rows[rows.length - 1].seq.toString() : after.toString(),
  };
}
