import { prisma } from "@/lib/db/client";
import {
  matchCampaigns,
  type CampaignMatch,
  type MatchableCampaign,
} from "@/lib/matching/match-campaign";
import {
  IntentJudgmentUnavailableError,
  type JudgmentProvider,
} from "@/lib/matching/judgment-provider";

export interface MatchSource {
  /** DmLog.commentId: the comment id, or `dm:<messageId>` for an inbound DM. */
  dedupeId: string;
  text: string;
  commenterId: string;
  commenterName: string | null | undefined;
}

export interface MatchedCampaign {
  matchedKeyword: string | null;
  intentProbability: number | null;
}

export interface ResolvedMatches {
  /** Only campaigns that should proceed. Absent = do nothing for that campaign. */
  matched: Map<string, MatchedCampaign>;
  /** Set when the provider was unavailable. The caller processes `matched`, then throws this so the job retries. */
  deferredError: IntentJudgmentUnavailableError | null;
}

type ResolvableCampaign = MatchableCampaign & { workspaceId: string; instagramAccountId: string };

/** Log text for a comment the intent gate turned away, so the reason is visible in DM Logs. */
export function intentRejectionMessage(match: Readonly<CampaignMatch>): string {
  if (match.intentClosedReason === "no_provider")
    return "Intent gate closed: no usable TypeSafe key is configured";
  if (match.intentClosedReason === "provider_rejected")
    return "Intent gate closed: TypeSafe refused the request — check the API key, account and model setting";
  if (match.intentClosedReason === "no_description")
    return "Intent gate closed: campaign has no intent description";
  return `Intent gate rejected this comment (p=${match.intentProbability?.toFixed(2) ?? "?"})`;
}

/**
 * Decide which campaigns act on one comment (or inbound DM).
 *
 * A gate verdict is decided once per (campaign, comment) and afterwards read
 * from the DmLog row — never re-judged, never overwritten:
 * - a real rejection (SKIPPED_NO_MATCH with a probability) is final;
 * - any other row means the campaign already proceeded, so its stored values
 *   are reused without asking the provider again;
 * - a closure (SKIPPED_NO_MATCH with no probability: no key, a key the
 *   provider refused, no description) is not a verdict, so the comment is
 *   judged again once it can be. A provider refusal closes the gate without
 *   failing the job, since retrying cannot fix a bad key.
 *
 * Every write here is guarded so it can only create a row or touch a closure
 * row; a SENT/PENDING/FAILED row is never modified.
 *
 * A provider outage does not hold up campaigns that never enabled the gate:
 * they are returned in `matched`, and the outage comes back as
 * `deferredError` for the caller to throw once they are served.
 */
export async function resolveCampaignMatches({
  source,
  automations,
  provider,
}: {
  source: MatchSource;
  automations: ResolvableCampaign[];
  provider: JudgmentProvider | null;
}): Promise<ResolvedMatches> {
  const matched = new Map<string, MatchedCampaign>();
  let deferredError: IntentJudgmentUnavailableError | null = null;
  if (automations.length === 0) return { matched, deferredError };

  const rows = await prisma.dmLog.findMany({
    where: { commentId: source.dedupeId, automationId: { in: automations.map((a) => a.id) } },
    select: { automationId: true, status: true, matchedKeyword: true, intentProbability: true },
  });
  const rowByCampaign = new Map(rows.map((row) => [row.automationId, row]));

  const toEvaluate: ResolvableCampaign[] = [];
  const hadClosureRow = new Set<string>();
  for (const automation of automations) {
    const row = rowByCampaign.get(automation.id);
    if (!row) {
      toEvaluate.push(automation);
    } else if (row.status === "SKIPPED_NO_MATCH") {
      if (row.intentProbability !== null) continue; // a real rejection is final
      hadClosureRow.add(automation.id);
      toEvaluate.push(automation);
    } else {
      matched.set(automation.id, {
        matchedKeyword: row.matchedKeyword,
        intentProbability: row.intentProbability,
      });
    }
  }
  if (toEvaluate.length === 0) return { matched, deferredError };

  let results: Map<string, Readonly<CampaignMatch>>;
  try {
    results = await matchCampaigns({
      text: source.text,
      authorHandle: source.commenterName ?? null,
      campaigns: toEvaluate,
      provider,
    });
  } catch (error) {
    if (!(error instanceof IntentJudgmentUnavailableError)) throw error;
    deferredError = error;
    // Ungated campaigns need no judgment; a null provider guarantees no call.
    results = await matchCampaigns({
      text: source.text,
      authorHandle: source.commenterName ?? null,
      campaigns: toEvaluate.filter((a) => !a.intentGateEnabled),
      provider: null,
    });
  }

  for (const automation of toEvaluate) {
    const result = results.get(automation.id);
    if (!result) continue;
    const closureRowWhere = {
      automationId: automation.id,
      commentId: source.dedupeId,
      status: "SKIPPED_NO_MATCH" as const,
      intentProbability: null,
    };

    if (result.matched) {
      if (hadClosureRow.has(automation.id)) {
        await prisma.dmLog.updateMany({
          where: closureRowWhere,
          data: {
            status: "PENDING",
            intentProbability: result.intentProbability,
            errorMessage: null,
            matchedKeyword: result.matchedKeyword,
          },
        });
      }
      matched.set(automation.id, {
        matchedKeyword: result.matchedKeyword,
        intentProbability: result.intentProbability,
      });
      continue;
    }

    if (!result.intentRejected) continue; // plain keyword miss: nothing to record

    const errorMessage = intentRejectionMessage(result);
    await prisma.dmLog.upsert({
      where: { automationId_commentId: { automationId: automation.id, commentId: source.dedupeId } },
      create: {
        workspaceId: automation.workspaceId,
        automationId: automation.id,
        instagramAccountId: automation.instagramAccountId,
        commenterId: source.commenterId,
        commenterName: source.commenterName,
        commentText: source.text,
        commentId: source.dedupeId,
        matchedKeyword: result.matchedKeyword,
        status: "SKIPPED_NO_MATCH",
        intentProbability: result.intentProbability,
        errorMessage,
      },
      update: {},
    });
    if (result.intentProbability !== null) {
      // A real judgment replaces a closure row; any other row is left alone.
      await prisma.dmLog.updateMany({
        where: closureRowWhere,
        data: { intentProbability: result.intentProbability, errorMessage },
      });
    } else if (hadClosureRow.has(automation.id)) {
      // Still closed, possibly for a different reason: show the current one in DM Logs.
      await prisma.dmLog.updateMany({ where: closureRowWhere, data: { errorMessage } });
    }
  }

  return { matched, deferredError };
}
