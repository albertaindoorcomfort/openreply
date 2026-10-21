import type { InboundMail, MicrosoftConnection } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { getBaseUrl } from "@/lib/env";
import { internalDomains, isInternal } from "@/lib/meetings/events";
import { RelayError, type InboundEventInput, type RelayApi } from "@/lib/meetings/relay-client";
import { hasScope } from "./config";
import { GraphClient, GraphError, type GraphAttachmentMeta, type GraphMessage } from "./graph";
import { ensureSubscription } from "./subscriptions";

/**
 * Inbound Outlook mail for the lead inbox.
 *
 * Only the service mailbox (LEADS_OUTLOOK_MAILBOX) is read; staff mailboxes
 * connected for meetings never are. New Inbox messages arrive two ways: a
 * Graph subscription (fast) and an Inbox delta query on every cron run (the
 * backstop for missed or failed notifications). Both go through
 * processMessage, and the InboundMail ledger makes them one post to Relay's
 * POST /events, which is itself idempotent on externalMessageId.
 *
 * Mail from the mailbox itself or from internal domains is skipped: Relay
 * already records sent replies as outbound, and re-ingesting them would look
 * like customer messages.
 */

const MAX_ATTEMPTS = 8;
const MAX_ATTACHMENTS = 20;
const MAX_BODY = 50_000;
const DEFAULT_LOOKBACK_HOURS = 72;

export interface MailDeps {
  graph: GraphClient;
  relay: RelayApi | null;
  now?: () => Date;
}

export function serviceMailbox(): string | null {
  const v = (process.env.LEADS_OUTLOOK_MAILBOX ?? "").trim().toLowerCase();
  return v.includes("@") ? v : null;
}

/** True when this connection is the service mailbox and may read mail. */
export function readsLeadMail(c: Pick<MicrosoftConnection, "email" | "status" | "grantedScopes">): boolean {
  const mailbox = serviceMailbox();
  return (
    !!mailbox &&
    c.status === "ACTIVE" &&
    c.email.toLowerCase() === mailbox &&
    (hasScope(c.grantedScopes, "Mail.Read") || hasScope(c.grantedScopes, "Mail.ReadWrite"))
  );
}

function lookbackMs() {
  const hours = Number(process.env.MAIL_INGEST_LOOKBACK_HOURS);
  return (Number.isFinite(hours) && hours >= 0 ? hours : DEFAULT_LOOKBACK_HOURS) * 3_600_000;
}

/**
 * Starts ingestion for the service mailbox: fixes the start time on first use
 * (so connecting never imports the whole mailbox) and keeps the Inbox
 * subscription alive. Returns false for any other mailbox.
 */
export async function startMailIngest(connectionId: string, graph: GraphClient, now = new Date()) {
  const connection = await prisma.microsoftConnection.findUniqueOrThrow({ where: { id: connectionId } });
  if (!readsLeadMail(connection)) return false;
  if (!connection.mailIngestFrom) {
    await prisma.microsoftConnection.updateMany({
      where: { id: connectionId, mailIngestFrom: null },
      data: { mailIngestFrom: new Date(now.getTime() - lookbackMs()) },
    });
  }
  await ensureSubscription(connectionId, graph, "mail", now);
  return true;
}

const address = (m: GraphMessage, key: "from" | "sender") => m[key]?.emailAddress?.address?.trim().toLowerCase() ?? "";

/** Why a message is not a customer message for the lead inbox, or null. */
export function skipReason(m: GraphMessage, c: Pick<MicrosoftConnection, "email" | "mailIngestFrom">): string | null {
  const mailbox = c.email.toLowerCase();
  const from = address(m, "from");
  if (m.isDraft) return "DRAFT";
  if (!from.includes("@")) return "NO_SENDER";
  if (from === mailbox || address(m, "sender") === mailbox) return "FROM_MAILBOX";
  if (isInternal(from, internalDomains(mailbox))) return "INTERNAL_SENDER";
  if (/^(mailer-daemon|postmaster)@/.test(from)) return "SYSTEM_SENDER";
  if (!m.internetMessageId || !m.conversationId) return "NO_MESSAGE_ID";
  const received = m.receivedDateTime ? new Date(m.receivedDateTime) : null;
  if (!received || Number.isNaN(received.getTime())) return "NO_RECEIVED_TIME";
  if (c.mailIngestFrom && received < c.mailIngestFrom) return "BEFORE_INGEST_START";
  return null;
}

/** Signed-in staff download attachments through the app; Graph is never exposed. */
export function attachmentUrl(connectionId: string, messageId: string, attachmentId: string) {
  return `${getBaseUrl()}/api/microsoft/mail/attachments/${encodeURIComponent(connectionId)}/${encodeURIComponent(messageId)}/${encodeURIComponent(attachmentId)}`;
}

export function toInboundEvent(
  m: GraphMessage,
  c: Pick<MicrosoftConnection, "id" | "email">,
  attachments: GraphAttachmentMeta[]
): InboundEventInput {
  const unique = m.uniqueBody?.content?.trim();
  const body = unique || m.body?.content?.trim() || "";
  const name = m.from?.emailAddress?.name?.trim();
  return {
    channel: "EMAIL",
    channelAccountRef: c.email.toLowerCase(),
    externalThreadId: m.conversationId!,
    externalMessageId: m.internetMessageId!,
    occurredAt: new Date(m.receivedDateTime!).toISOString(),
    from: {
      ...(name ? { displayName: name.slice(0, 200) } : {}),
      identities: [{ kind: "EMAIL", value: address(m, "from") }],
    },
    ...(m.subject ? { subject: m.subject.slice(0, 500) } : {}),
    body: body.slice(0, MAX_BODY),
    kind: "MESSAGE",
    attachments: attachments.map((a) => ({
      name: (a.name || "attachment").slice(0, 300),
      url: attachmentUrl(c.id, m.id, a.id),
      ...(a.contentType ? { contentType: a.contentType.slice(0, 200) } : {}),
    })),
  };
}

/** File attachments a person would open; inline images and attached items are left out. */
async function fileAttachments(graph: GraphClient, m: GraphMessage) {
  if (!m.hasAttachments) return [];
  const list = await graph.listAttachments(m.id);
  return list
    .filter((a) => !a.isInline && (!a["@odata.type"] || a["@odata.type"] === "#microsoft.graph.fileAttachment"))
    .slice(0, MAX_ATTACHMENTS);
}

/** Relay refused the event itself; sending it again cannot succeed. */
const permanent = (e: unknown) => e instanceof RelayError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429;

const errorText = (e: unknown) =>
  e instanceof GraphError || e instanceof RelayError ? e.message : e instanceof Error ? e.message.slice(0, 200) : "error";

export type MailOutcome = "delivered" | "duplicate" | "skipped" | "failed" | "dead" | "done" | "busy";

/**
 * Ingests one message by its immutable Graph id. Safe to call any number of
 * times from webhooks, delta and retries; never throws for a message-level
 * failure, which is recorded on the ledger and retried with backoff.
 */
export async function processMessage(connection: MicrosoftConnection, graphMessageId: string, deps: MailDeps): Promise<MailOutcome> {
  const now = deps.now?.() ?? new Date();
  await prisma.inboundMail.createMany({
    data: [{ workspaceId: connection.workspaceId, connectionId: connection.id, graphMessageId }],
    skipDuplicates: true,
  });
  const row = await prisma.inboundMail.findUniqueOrThrow({
    where: { connectionId_graphMessageId: { connectionId: connection.id, graphMessageId } },
  });
  if (row.status === "DELIVERED" || row.status === "SKIPPED" || row.status === "DEAD") return "done";

  // Claim the row; a webhook and the delta backstop racing on one message post it once.
  const claimed = await prisma.inboundMail.updateMany({
    where: { id: row.id, attempts: row.attempts, status: row.status },
    data: { attempts: { increment: 1 }, nextAttemptAt: new Date(now.getTime() + 5 * 60_000) },
  });
  if (!claimed.count) return "busy";
  return deliver(connection, row, deps, now);
}

async function deliver(connection: MicrosoftConnection, row: InboundMail, deps: MailDeps, now: Date): Promise<MailOutcome> {
  const finish = (data: Partial<InboundMail>) => prisma.inboundMail.update({ where: { id: row.id }, data: { ...data, lastError: data.lastError ?? null } });
  try {
    let m: GraphMessage;
    try {
      m = await deps.graph.getMessage(row.graphMessageId);
    } catch (e) {
      if (e instanceof GraphError && e.isNotFound) {
        await finish({ status: "SKIPPED", skipReason: "DELETED" });
        return "skipped";
      }
      throw e;
    }
    const meta = {
      internetMessageId: m.internetMessageId ?? null,
      receivedAt: m.receivedDateTime ? new Date(m.receivedDateTime) : null,
    };
    const reason = skipReason(m, connection);
    if (reason) {
      await finish({ ...meta, status: "SKIPPED", skipReason: reason });
      return "skipped";
    }
    if (!deps.relay) throw new Error("relay not configured");
    const event = toInboundEvent(m, connection, await fileAttachments(deps.graph, m));
    const result = await deps.relay.postInboundEvent(event);
    await finish({
      ...meta,
      status: "DELIVERED",
      relayConversationId: result.conversationId ?? null,
      relayMessageId: result.messageId ?? null,
    });
    return result.duplicate ? "duplicate" : "delivered";
  } catch (e) {
    const attempts = row.attempts + 1;
    const dead = permanent(e) || attempts >= MAX_ATTEMPTS;
    await finish({
      status: dead ? "DEAD" : "FAILED",
      lastError: errorText(e),
      nextAttemptAt: new Date(now.getTime() + 2 ** attempts * 60_000),
    });
    return dead ? "dead" : "failed";
  }
}

/**
 * The backstop: an Inbox delta round from the stored link (or from
 * mailIngestFrom). Picks up anything a notification missed. An expired
 * delta token (410) restarts the round; the ledger absorbs the overlap.
 */
export async function syncInbox(connectionId: string, deps: MailDeps) {
  const connection = await prisma.microsoftConnection.findUniqueOrThrow({ where: { id: connectionId } });
  const counts: Record<MailOutcome, number> = { delivered: 0, duplicate: 0, skipped: 0, failed: 0, dead: 0, done: 0, busy: 0 };
  if (!readsLeadMail(connection) || !connection.mailIngestFrom) return counts;

  let link = connection.mailDeltaLink ?? GraphClient.inboxDeltaStart(connection.mailIngestFrom);
  for (let pages = 0; pages < 200; pages++) {
    let page;
    try {
      page = await deps.graph.inboxDeltaPage(link);
    } catch (error) {
      if (error instanceof GraphError && error.status === 410 && connection.mailDeltaLink) {
        await prisma.microsoftConnection.update({ where: { id: connectionId }, data: { mailDeltaLink: null } });
        return syncInbox(connectionId, deps);
      }
      throw error;
    }
    for (const m of page.value) {
      if (m["@removed"]) continue;
      // Delta can return changes outside its filter; old mail is not looked up at all.
      const received = m.receivedDateTime ? new Date(m.receivedDateTime) : null;
      if (received && received < connection.mailIngestFrom) continue;
      counts[await processMessage(connection, m.id, deps)]++;
    }
    if (page["@odata.deltaLink"]) {
      await prisma.microsoftConnection.update({
        where: { id: connectionId },
        data: { mailDeltaLink: page["@odata.deltaLink"], mailSyncedAt: new Date() },
      });
      break;
    }
    if (!page["@odata.nextLink"]) break;
    link = page["@odata.nextLink"];
  }
  return counts;
}

/** Retries failed deliveries whose backoff has passed. */
export async function retryFailedMail(graphFor: (connectionId: string) => GraphClient, relay: RelayApi | null, now = new Date(), limit = 100) {
  const due = await prisma.inboundMail.findMany({
    where: { status: { in: ["PENDING", "FAILED"] }, nextAttemptAt: { lte: now }, connection: { status: "ACTIVE" } },
    include: { connection: true },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  const counts: Partial<Record<MailOutcome, number>> = {};
  for (const row of due) {
    const outcome = await processMessage(row.connection, row.graphMessageId, { graph: graphFor(row.connectionId), relay, now: () => now });
    counts[outcome] = (counts[outcome] ?? 0) + 1;
  }
  return counts;
}
