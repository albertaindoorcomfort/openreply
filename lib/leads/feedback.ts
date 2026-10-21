import { z } from "zod";
import { prisma } from "@/lib/db/client";
import type { Prisma } from "@/app/generated/prisma/client";
import { LeadError, notFound } from "./errors";
import { recordEvent, type Actor } from "./timeline";

export const AssessmentCorrectionSchema = z
  .object({
    intent: z.string().max(50).optional(),
    urgency: z.enum(["LOW", "NORMAL", "HIGH", "EMERGENCY"]).optional(),
    sentiment: z.enum(["positive", "neutral", "negative"]).optional(),
    leadScore: z.number().int().min(0).max(100).optional(),
    summary: z.string().max(1500).optional(),
  })
  .strict();

export const FeedbackSchema = z.discriminatedUnion("targetKind", [
  z.object({ targetKind: z.literal("ASSESSMENT"), targetId: z.string().max(100), corrected: AssessmentCorrectionSchema, reason: z.string().max(2000).optional() }).strict(),
  z.object({
    targetKind: z.enum(["DRAFT", "RECOMMENDATION", "SUMMARY", "ROUTING", "MEETING_NOTE"]),
    targetId: z.string().max(100),
    conversationId: z.string().max(100).optional(),
    original: z.record(z.string(), z.unknown()).optional(),
    corrected: z.record(z.string(), z.unknown()),
    reason: z.string().max(2000).optional(),
  }).strict(),
]);

/**
 * Stores a person's correction. An assessment correction also takes effect at
 * once, as a new assessment by that person that supersedes Carla's, so the
 * inbox shows the corrected view. Nothing here changes Carla's instructions:
 * corrections feed her context and the evaluation set only.
 */
export async function recordFeedback(
  actor: Actor,
  input: z.input<typeof FeedbackSchema>,
  opts: { correctedBy?: string; idempotencyKey?: string; contactId?: string } = {},
) {
  const f = FeedbackSchema.parse(input);
  // A person always owns a correction: the signed-in user, or the one a module names.
  const userId = opts.correctedBy ?? (actor.kind === "USER" ? actor.id : null);
  if (!userId) throw new LeadError("CORRECTED_BY_REQUIRED", 400, "A correction must name the person who made it.");
  const idempotencyKey = opts.idempotencyKey ?? null;
  return prisma.$transaction(async (tx) => {
    if (idempotencyKey) {
      const existing = await tx.feedback.findUnique({ where: { workspaceId_idempotencyKey: { workspaceId: actor.workspaceId, idempotencyKey } } });
      if (existing) return existing;
    }
    if (opts.correctedBy) {
      const member = await tx.workspaceMember.count({ where: { workspaceId: actor.workspaceId, userId: opts.correctedBy } });
      if (!member) throw notFound("Member");
    }
    if (opts.contactId) {
      const c = await tx.contact.count({ where: { id: opts.contactId, workspaceId: actor.workspaceId } });
      if (!c) throw notFound("Contact");
    }
    if (f.targetKind === "ASSESSMENT") {
      const original = await tx.assessment.findFirst({ where: { id: f.targetId, workspaceId: actor.workspaceId } });
      if (!original) throw notFound("Assessment");
      const fb = await tx.feedback.create({
        data: {
          workspaceId: actor.workspaceId, targetKind: "ASSESSMENT", targetId: original.id, conversationId: original.conversationId,
          original: { intent: original.intent, urgency: original.urgency, sentiment: original.sentiment, leadScore: original.leadScore, summary: original.summary },
          corrected: f.corrected, reason: f.reason, userId, idempotencyKey,
        },
      });
      await tx.assessment.updateMany({ where: { conversationId: original.conversationId, supersededAt: null }, data: { supersededAt: new Date() } });
      await tx.assessment.create({
        data: {
          workspaceId: actor.workspaceId, conversationId: original.conversationId, contactId: original.contactId,
          intent: f.corrected.intent ?? original.intent, urgency: f.corrected.urgency ?? original.urgency,
          sentiment: f.corrected.sentiment ?? original.sentiment, leadScore: f.corrected.leadScore ?? original.leadScore,
          summary: f.corrected.summary ?? original.summary, nextActions: original.nextActions as Prisma.InputJsonValue,
          evidence: original.evidence as Prisma.InputJsonValue, producer: `human:${userId}`, confidence: 1,
        },
      });
      if (f.corrected.leadScore !== undefined) {
        await tx.contact.update({ where: { id: original.contactId }, data: { leadScore: f.corrected.leadScore } });
      }
      await recordEvent(tx, actor, { type: "feedback.recorded", contactId: original.contactId, conversationId: original.conversationId, payload: { feedbackId: fb.id, targetKind: "ASSESSMENT" } });
      return fb;
    }
    if (f.conversationId) {
      const c = await tx.conversation.count({ where: { id: f.conversationId, workspaceId: actor.workspaceId } });
      if (!c) throw notFound("Conversation");
    }
    const fb = await tx.feedback.create({
      data: {
        workspaceId: actor.workspaceId, targetKind: f.targetKind, targetId: f.targetId, conversationId: f.conversationId,
        original: f.original as Prisma.InputJsonValue | undefined, corrected: f.corrected as Prisma.InputJsonValue, reason: f.reason, userId, idempotencyKey,
      },
    });
    await recordEvent(tx, actor, { type: "feedback.recorded", contactId: opts.contactId, conversationId: f.conversationId, payload: { feedbackId: fb.id, targetKind: f.targetKind } });
    return fb;
  });
}

export async function listFeedback(actor: Actor, status?: "NEW" | "TRIAGED" | "IN_EVAL" | "ADOPTED" | "REJECTED") {
  return prisma.feedback.findMany({
    where: { workspaceId: actor.workspaceId, ...(status ? { status } : {}) },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
}
