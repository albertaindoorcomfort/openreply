import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { prisma } from "@/lib/db/client";
import { graphNotificationUrls } from "./config";
import { markNeedsReauth } from "./connection";
import { GraphError, type GraphClient } from "./graph";

/**
 * Graph change-notification subscriptions for a mailbox's calendar.
 *
 * Outlook event subscriptions may live up to 10,080 minutes. We ask for three
 * days and renew anything inside 24 hours of expiry on every cron run, so a
 * missed run or two never lets one lapse. Lifecycle notifications
 * (reauthorizationRequired, subscriptionRemoved, missed) arrive at a separate
 * endpoint and are handled in notifications.ts.
 */

export const CALENDAR_RESOURCE = "me/events";
const LIFETIME_MS = 3 * 24 * 60 * 60 * 1000;
const RENEW_WITHIN_MS = 24 * 60 * 60 * 1000;

export const hashClientState = (value: string) => createHash("sha256").update(value).digest("hex");

export function clientStateMatches(received: string | undefined, storedHash: string): boolean {
  if (!received) return false;
  const a = Buffer.from(hashClientState(received), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function createCalendarSubscription(connectionId: string, graph: GraphClient, now = new Date()) {
  const connection = await prisma.microsoftConnection.findUniqueOrThrow({ where: { id: connectionId } });
  const clientState = randomBytes(32).toString("base64url");
  const sub = await graph.createSubscription({
    resource: CALENDAR_RESOURCE,
    changeType: "created,updated,deleted",
    ...graphNotificationUrls(),
    clientState,
    expiresAt: new Date(now.getTime() + LIFETIME_MS),
  });
  return prisma.graphSubscription.create({
    data: {
      workspaceId: connection.workspaceId,
      connectionId,
      graphSubscriptionId: sub.id,
      resource: CALENDAR_RESOURCE,
      changeType: "created,updated,deleted",
      clientStateHash: hashClientState(clientState),
      expiresAt: new Date(sub.expirationDateTime),
      lastRenewedAt: now,
    },
  });
}

/** Creates the calendar subscription if the connection has no live one. */
export async function ensureCalendarSubscription(connectionId: string, graph: GraphClient, now = new Date()) {
  const live = await prisma.graphSubscription.findFirst({
    where: { connectionId, resource: CALENDAR_RESOURCE, status: { in: ["ACTIVE", "RENEW_FAILED"] }, expiresAt: { gt: now } },
  });
  return live ?? createCalendarSubscription(connectionId, graph, now);
}

export type RenewOutcome = "renewed" | "recreated" | "needs_reauth" | "failed";

/** Extends one subscription; a subscription Graph no longer knows is replaced. */
export async function renewSubscription(subscriptionRowId: string, graph: GraphClient, now = new Date()): Promise<RenewOutcome> {
  const row = await prisma.graphSubscription.findUniqueOrThrow({ where: { id: subscriptionRowId } });
  const replace = async () => {
    await prisma.graphSubscription.update({ where: { id: row.id }, data: { status: "REMOVED" } });
    await createCalendarSubscription(row.connectionId, graph, now);
    return "recreated" as const;
  };

  if (row.expiresAt <= now) return replace();
  try {
    const sub = await graph.renewSubscription(row.graphSubscriptionId, new Date(now.getTime() + LIFETIME_MS));
    await prisma.graphSubscription.update({
      where: { id: row.id },
      data: { status: "ACTIVE", expiresAt: new Date(sub.expirationDateTime), lastRenewedAt: now, failureCount: 0, lastError: null },
    });
    return "renewed";
  } catch (error) {
    if (error instanceof GraphError && error.status === 404) return replace();
    if (error instanceof GraphError && (error.status === 401 || error.status === 403)) {
      await markNeedsReauth(row.connectionId, `subscription renew ${error.status}`);
      return "needs_reauth";
    }
    await prisma.graphSubscription.update({
      where: { id: row.id },
      data: {
        status: "RENEW_FAILED",
        failureCount: { increment: 1 },
        lastError: error instanceof GraphError ? `${error.status} ${error.code}` : "network",
      },
    });
    return "failed";
  }
}

export function subscriptionsDueForRenewal(now = new Date()) {
  return prisma.graphSubscription.findMany({
    where: {
      status: { in: ["ACTIVE", "RENEW_FAILED"] },
      expiresAt: { lt: new Date(now.getTime() + RENEW_WITHIN_MS) },
      connection: { status: "ACTIVE" },
    },
  });
}

/** Removes Graph subscriptions when a user disconnects; Graph errors are ignored. */
export async function removeConnectionSubscriptions(connectionId: string, graph: GraphClient) {
  const subs = await prisma.graphSubscription.findMany({ where: { connectionId, status: { not: "REMOVED" } } });
  for (const s of subs) {
    await graph.deleteSubscription(s.graphSubscriptionId).catch(() => undefined);
    await prisma.graphSubscription.update({ where: { id: s.id }, data: { status: "REMOVED" } });
  }
}
