import { createHash } from "crypto";
import { z } from "zod";
import type { GraphNotification } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { applyGraphEvent, syncCalendar } from "@/lib/meetings/sync";
import type { RelayApi } from "@/lib/meetings/relay-client";
import { ConnectionUnavailableError } from "./connection";
import { GraphError, type GraphClient } from "./graph";
import { clientStateMatches, createCalendarSubscription, renewSubscription } from "./subscriptions";

/**
 * Inbound Graph change notifications.
 *
 * The webhook only stores what arrived and returns 202 (Graph expects an
 * answer within a few seconds and retries otherwise). Processing fetches the
 * current event from Graph, so a notification is a hint, never data:
 * a forged or replayed one can at most cause a re-read.
 *
 * Idempotency: while a notification for an event is pending, more for the
 * same event collapse into it (the dedupe key). Once processed, its key is
 * retired so a later change makes a new row. Applying the same event twice is
 * a no-op because sync compares changeKey.
 */

const MAX_ATTEMPTS = 8;

const notification = z.object({
  subscriptionId: z.string(),
  clientState: z.string().optional(),
  changeType: z.string().optional(),
  lifecycleEvent: z.string().optional(),
  resource: z.string().optional(),
  resourceData: z.object({ id: z.string().optional(), "@odata.etag": z.string().optional() }).passthrough().optional(),
});
export const notificationBatch = z.object({ value: z.array(notification).max(1000) });
export type GraphNotificationInput = z.infer<typeof notification>;

const pendingKey = (subscriptionId: string, kind: string, resourceId: string | null) =>
  createHash("sha256").update(`${subscriptionId}|${kind}|${resourceId ?? "-"}|pending`).digest("hex");

export interface IngestResult {
  accepted: number;
  duplicates: number;
  rejected: number;
  connectionIds: string[];
}

export async function ingestNotifications(items: GraphNotificationInput[]): Promise<IngestResult> {
  const result: IngestResult = { accepted: 0, duplicates: 0, rejected: 0, connectionIds: [] };
  for (const n of items) {
    const sub = await prisma.graphSubscription.findUnique({ where: { graphSubscriptionId: n.subscriptionId } });
    // Unknown subscription or wrong clientState: not ours, or forged. Drop it.
    if (!sub || sub.status === "REMOVED" || !clientStateMatches(n.clientState, sub.clientStateHash)) {
      result.rejected++;
      continue;
    }
    const kind = n.lifecycleEvent ? `lifecycle:${n.lifecycleEvent}` : n.changeType ?? "updated";
    const resourceId = n.lifecycleEvent ? null : n.resourceData?.id ?? null;
    const created = await prisma.graphNotification.createMany({
      data: [
        {
          workspaceId: sub.workspaceId,
          connectionId: sub.connectionId,
          graphSubscriptionId: sub.graphSubscriptionId,
          dedupeKey: pendingKey(sub.graphSubscriptionId, kind, resourceId),
          changeType: n.changeType ?? "lifecycle",
          resourceId,
          lifecycleEvent: n.lifecycleEvent ?? null,
        },
      ],
      skipDuplicates: true,
    });
    if (created.count) result.accepted++;
    else result.duplicates++;
    if (!result.connectionIds.includes(sub.connectionId)) result.connectionIds.push(sub.connectionId);
  }
  return result;
}

export interface ProcessDeps {
  graph(connectionId: string): GraphClient;
  relay: RelayApi | null;
  now?: () => Date;
}

async function handle(row: GraphNotification, deps: ProcessDeps) {
  const graph = deps.graph(row.connectionId);
  if (row.lifecycleEvent) {
    const sub = await prisma.graphSubscription.findUnique({ where: { graphSubscriptionId: row.graphSubscriptionId } });
    if (row.lifecycleEvent === "reauthorizationRequired" && sub) {
      await renewSubscription(sub.id, graph);
    } else if (row.lifecycleEvent === "subscriptionRemoved") {
      if (sub) await prisma.graphSubscription.update({ where: { id: sub.id }, data: { status: "REMOVED" } });
      await createCalendarSubscription(row.connectionId, graph);
      await syncCalendar(row.connectionId, graph, deps.relay);
    } else if (row.lifecycleEvent === "missed") {
      await syncCalendar(row.connectionId, graph, deps.relay);
    }
    return;
  }

  const connection = await prisma.microsoftConnection.findUniqueOrThrow({ where: { id: row.connectionId } });
  if (!row.resourceId) return;
  if (row.changeType === "deleted") {
    await applyGraphEvent(connection, { id: row.resourceId, "@removed": { reason: "deleted" } }, deps.relay);
    return;
  }
  try {
    const ev = await graph.getEvent(row.resourceId);
    await applyGraphEvent(connection, ev, deps.relay);
  } catch (error) {
    if (error instanceof GraphError && error.isNotFound) {
      await applyGraphEvent(connection, { id: row.resourceId, "@removed": { reason: "deleted" } }, deps.relay);
      return;
    }
    throw error;
  }
}

/**
 * Processes due notifications. Failures back off exponentially; after
 * MAX_ATTEMPTS a row is DEAD and a full delta sync reconciles the calendar.
 */
export async function processPendingNotifications(deps: ProcessDeps, opts: { connectionId?: string; limit?: number } = {}) {
  const now = deps.now?.() ?? new Date();
  const due = await prisma.graphNotification.findMany({
    where: {
      status: { in: ["PENDING", "FAILED"] },
      nextAttemptAt: { lte: now },
      ...(opts.connectionId ? { connectionId: opts.connectionId } : {}),
    },
    orderBy: { receivedAt: "asc" },
    take: opts.limit ?? 100,
  });

  const stats = { processed: 0, failed: 0, dead: 0 };
  for (const row of due) {
    // Claim the row; a concurrent worker that already took it updates nothing.
    const claimed = await prisma.graphNotification.updateMany({
      where: { id: row.id, attempts: row.attempts, status: row.status },
      data: { attempts: { increment: 1 }, nextAttemptAt: new Date(now.getTime() + 5 * 60_000) },
    });
    if (!claimed.count) continue;
    try {
      await handle(row, deps);
      await prisma.graphNotification.update({
        where: { id: row.id },
        data: { status: "PROCESSED", processedAt: new Date(), lastError: null, dedupeKey: `${row.dedupeKey}:${row.id}` },
      });
      stats.processed++;
    } catch (error) {
      const attempts = row.attempts + 1;
      const dead = attempts >= MAX_ATTEMPTS || error instanceof ConnectionUnavailableError;
      await prisma.graphNotification.update({
        where: { id: row.id },
        data: {
          status: dead ? "DEAD" : "FAILED",
          lastError: error instanceof GraphError ? `${error.status} ${error.code}` : error instanceof Error ? error.message.slice(0, 200) : "error",
          nextAttemptAt: new Date(now.getTime() + 2 ** attempts * 60_000),
          // A dead row frees its key so new notifications still land.
          ...(dead ? { dedupeKey: `${row.dedupeKey}:${row.id}` } : {}),
        },
      });
      if (dead) {
        stats.dead++;
        // Reconcile what the dead notification would have told us.
        await prisma.microsoftConnection.updateMany({ where: { id: row.connectionId }, data: { calendarSyncedAt: null } });
      } else stats.failed++;
    }
  }
  return stats;
}
