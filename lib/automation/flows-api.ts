/**
 * Relay flows over the service API, for Apollo's Social seat and the
 * publishing suite's "Relay" option on a post.
 *
 * Reads need a key with flows:read. Creating a flow needs flows:write and a
 * flow grant: a person approved this exact flow in Apollo, and the grant
 * carries the SHA-256 of the request body. The flow then answers comments on
 * the post publicly and sends the DM to commenters who use a keyword, exactly
 * as a flow made in the dashboard does.
 */
import { z } from "zod";
import { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { LeadError, notFound } from "@/lib/leads/errors";
import { sha256Hex, verifyFlowGrant } from "@/lib/leads/grant";
import { calculateCtr, normalizeTopKeywords, summarizeDmStatuses } from "@/lib/tracking/analytics";
import { buildInitialCampaignLinks } from "@/lib/campaigns/links";
import { generateReportShareSlug } from "@/lib/reports/share";

const https = z.string().url().max(2000).refine((u) => u.startsWith("https://"), "Links must use https");

export const FlowBody = z
  .object({
    workspaceId: z.string().max(100).optional(),
    /** Only Instagram is connected today; the field is here so other platforms slot in. */
    platform: z.literal("instagram").default("instagram"),
    instagramAccountId: z.string().min(1).max(100).optional(),
    name: z.string().min(1).max(100),
    goal: z.string().min(1).max(120).optional(),
    /** The published post's media id, or nextReel to bind the account's next reel. */
    postId: z.string().regex(/^[0-9A-Za-z_]{1,64}$/).optional(),
    postUrl: https.optional(),
    nextReel: z.boolean().default(false),
    keywords: z.array(z.string().trim().min(1).max(50)).max(10).default([]),
    matchAnyWord: z.boolean().default(false),
    /** The DM a matching commenter receives. */
    dmMessage: z.string().trim().min(1).max(1000),
    /** Public replies under the comment, one picked per comment. Empty means no public reply. */
    publicReplies: z.array(z.string().trim().min(1).max(1000)).max(10).default([]),
    linkUrl: https.optional(),
    linkButtonLabel: z.string().trim().min(1).max(20).optional(),
    requireFollow: z.boolean().default(false),
  })
  .strict()
  .refine((d) => d.nextReel !== Boolean(d.postId), { message: "Give a postId or nextReel, not both", path: ["postId"] })
  .refine((d) => d.matchAnyWord || d.keywords.length > 0, { message: "Add a keyword, or match any word", path: ["keywords"] });

export type FlowBody = z.infer<typeof FlowBody>;

/**
 * Creates the flow a person approved. The grant must name this workspace and
 * the exact body text, so nothing else can be switched on with it. A repeat of
 * the same approval returns the flow it already made.
 */
export async function createFlowWithGrant(workspaceId: string, rawBody: string, grant: string) {
  const check = verifyFlowGrant(process.env.RELAY_GRANT_SECRET, grant);
  if (!check.ok) throw new LeadError(`GRANT_${check.reason}`, 403);
  const { claims } = check;
  if (claims.workspaceId !== workspaceId) throw new LeadError("GRANT_WRONG_WORKSPACE", 403);
  if (claims.bodySha256 !== sha256Hex(rawBody)) throw new LeadError("GRANT_BODY_MISMATCH", 403);

  const body = FlowBody.parse(JSON.parse(rawBody));
  if (body.workspaceId && body.workspaceId !== workspaceId) throw new LeadError("GRANT_WRONG_WORKSPACE", 403);

  const replay = await prisma.automation.findUnique({ where: { approvalId: claims.approvalId }, select: { id: true, workspaceId: true } });
  if (replay) {
    if (replay.workspaceId !== workspaceId) throw new LeadError("GRANT_WRONG_WORKSPACE", 403);
    return { flowId: replay.id, replay: true };
  }

  const account = await prisma.instagramAccount.findFirst({
    where: body.instagramAccountId ? { id: body.instagramAccountId, workspaceId } : { workspaceId },
    orderBy: { connectedAt: "desc" },
    select: { id: true },
  });
  if (!account) throw new LeadError("ACCOUNT_NOT_CONNECTED", 422, "Connect the account before adding a flow");

  const links = buildInitialCampaignLinks({ workspaceId, primaryUrl: body.linkUrl ?? null });
  try {
    const flow = await prisma.automation.create({
      data: {
        workspaceId,
        instagramAccountId: account.id,
        approvalId: claims.approvalId,
        name: body.name,
        goal: body.goal ?? null,
        postId: body.postId ?? null,
        postUrl: body.postId ? body.postUrl ?? null : null,
        pendingNextReel: body.nextReel,
        keywords: body.matchAnyWord ? [] : body.keywords,
        matchAnyWord: body.matchAnyWord,
        dmMessage: body.dmMessage,
        linkButtonLabel: body.linkButtonLabel ?? null,
        requireFollow: body.requireFollow,
        publicReplyEnabled: body.publicReplies.length > 0,
        publicReplyMessages: body.publicReplies,
        publicReplyMessage: body.publicReplies[0] ?? null,
        isActive: true,
        reportShareSlug: generateReportShareSlug(),
        ...(links.length > 0 ? { trackedLinks: { create: links } } : {}),
      },
      select: { id: true },
    });
    return { flowId: flow.id, replay: false };
  } catch (err) {
    // A concurrent request with the same approval won the race: answer as a replay.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const won = await prisma.automation.findUnique({ where: { approvalId: claims.approvalId }, select: { id: true, workspaceId: true } });
      if (won && won.workspaceId === workspaceId) return { flowId: won.id, replay: true };
    }
    throw err;
  }
}

/** The workspace's flows, newest first, each with what it has done so far. */
export async function listFlows(workspaceId: string, limit = 20, flowId?: string) {
  const flows = await prisma.automation.findMany({
    where: { workspaceId, ...(flowId ? { id: flowId } : {}) },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(limit, 1), 100),
    select: {
      id: true, name: true, goal: true, isActive: true, postId: true, postUrl: true, pendingNextReel: true, matchAnyPost: true,
      keywords: true, matchAnyWord: true, publicReplyEnabled: true, createdAt: true,
    },
  });
  const ids = flows.map((f) => f.id);
  const [statuses, clicks, replies] = await Promise.all([
    prisma.dmLog.groupBy({ by: ["automationId", "status"], where: { workspaceId, automationId: { in: ids } }, _count: { _all: true } }),
    prisma.linkClick.groupBy({ by: ["automationId"], where: { workspaceId, automationId: { in: ids } }, _count: { _all: true } }),
    prisma.dmLog.groupBy({ by: ["automationId"], where: { workspaceId, automationId: { in: ids }, publicReplySentAt: { not: null } }, _count: { _all: true } }),
  ]);
  return flows.map((f) => {
    const dms = summarizeDmStatuses(statuses.filter((r) => r.automationId === f.id).map((r) => ({ status: r.status, _count: r._count._all })));
    const clickCount = clicks.find((r) => r.automationId === f.id)?._count._all ?? 0;
    return {
      ...f,
      results: {
        dmsSent: dms.sent, dmsSkipped: dms.skipped, dmsFailed: dms.failed,
        publicReplies: replies.find((r) => r.automationId === f.id)?._count._all ?? 0,
        clicks: clickCount, ctr: calculateCtr(clickCount, dms.sent),
      },
    };
  });
}

/** One flow's results, with the keywords that triggered it most. Comment text is never returned. */
export async function flowStats(workspaceId: string, flowId: string) {
  const [flow] = await listFlows(workspaceId, 1, flowId);
  if (!flow) throw notFound("Flow");
  const keywords = await prisma.dmLog.groupBy({
    by: ["matchedKeyword"],
    where: { workspaceId, automationId: flowId, matchedKeyword: { not: null } },
    _count: { _all: true },
  });
  return {
    ...flow,
    topKeywords: normalizeTopKeywords(keywords.map((r) => ({ matchedKeyword: r.matchedKeyword, _count: r._count._all })), 5),
  };
}

