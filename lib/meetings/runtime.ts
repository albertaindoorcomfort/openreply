import { prisma } from "@/lib/db/client";
import { getGraphClientForConnection } from "@/lib/microsoft/connection";
import { processPendingNotifications } from "@/lib/microsoft/notifications";
import { ensureCalendarSubscription, renewSubscription, subscriptionsDueForRenewal } from "@/lib/microsoft/subscriptions";
import { modelFromEnv } from "./model";
import { pushTimelineOutbox, purgeExpiredTranscripts } from "./outbox";
import { relayFromEnv } from "./relay-client";
import { completeEndedMeetings, syncCalendar } from "./sync";

/** Production dependencies for one connection. */
export function depsFor(connectionId: string) {
  return { graph: getGraphClientForConnection(connectionId), relay: relayFromEnv(), model: modelFromEnv() };
}

const errorText = (e: unknown) => (e instanceof Error ? e.message.slice(0, 200) : "error");

/**
 * The periodic job: keep subscriptions alive, retry failed notifications,
 * reconcile calendars, close out ended meetings, push timeline events and
 * apply retention. Each step is independent, so one failing does not stop
 * the others.
 */
export async function runMeetingsMaintenance(now = new Date()) {
  const report: Record<string, unknown> = {};
  const relay = relayFromEnv();

  const renewals: Record<string, number> = {};
  for (const sub of await subscriptionsDueForRenewal(now)) {
    const outcome = await renewSubscription(sub.id, getGraphClientForConnection(sub.connectionId), now).catch(() => "failed" as const);
    renewals[outcome] = (renewals[outcome] ?? 0) + 1;
  }
  report.renewals = renewals;

  try {
    report.notifications = await processPendingNotifications({ graph: getGraphClientForConnection, relay, now: () => now });
  } catch (e) {
    report.notifications = errorText(e);
  }

  const connections = await prisma.microsoftConnection.findMany({ where: { status: "ACTIVE" } });
  const syncs: Record<string, unknown> = {};
  for (const c of connections) {
    const graph = getGraphClientForConnection(c.id);
    try {
      await ensureCalendarSubscription(c.id, graph, now);
      syncs[c.id] = await syncCalendar(c.id, graph, relay);
    } catch (e) {
      syncs[c.id] = errorText(e);
    }
  }
  report.syncs = syncs;

  report.completed = await completeEndedMeetings(now);
  report.timeline = relay ? await pushTimelineOutbox(relay) : "relay not configured";
  report.purgedTranscripts = await purgeExpiredTranscripts(now);
  return report;
}
