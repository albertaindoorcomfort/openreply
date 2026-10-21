import type { ActorKind, Prisma } from "@/app/generated/prisma/client";

export type Tx = Prisma.TransactionClient;

/** Who did something. Agents and services act inside one workspace. */
export interface Actor {
  kind: ActorKind;
  id: string | null;
  workspaceId: string;
}

export interface TimelineInput {
  type: string;
  contactId?: string | null;
  conversationId?: string | null;
  opportunityId?: string | null;
  taskId?: string | null;
  payload?: Prisma.InputJsonValue;
  occurredAt?: Date;
}

/** Appends one event. Call it inside the same transaction as the change it records. */
export async function recordEvent(tx: Tx, actor: Actor, input: TimelineInput) {
  return tx.timelineEvent.create({
    data: {
      workspaceId: actor.workspaceId,
      actorKind: actor.kind,
      actorId: actor.id,
      type: input.type,
      contactId: input.contactId ?? null,
      conversationId: input.conversationId ?? null,
      opportunityId: input.opportunityId ?? null,
      taskId: input.taskId ?? null,
      payload: input.payload,
      ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
    },
  });
}
