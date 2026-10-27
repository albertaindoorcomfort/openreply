import { matchKeywords } from "@/lib/utils/keyword-matcher";
import { gateIntents, type IntentCandidate } from "./intent-gate";
import { IntentJudgmentRejectedError, type JudgmentProvider } from "./judgment-provider";

/** The fields of an Automation row that matching reads. Prisma rows satisfy this directly. */
export interface MatchableCampaign {
  id: string;
  keywords: string[];
  matchAnyWord: boolean;
  wholeWordMatch: boolean;
  intentGateEnabled: boolean;
  intentDescription: string | null;
  intentThreshold: number;
}

/** Why a gated campaign was closed without asking the model. */
export type IntentClosedReason = "no_provider" | "no_description" | "provider_rejected";

export interface CampaignMatch {
  matched: boolean;
  matchedKeyword: string | null;
  /** Set only when the gate actually ran for this campaign. */
  intentProbability: number | null;
  /** True when reach passed but the gate said no (or was closed). Drives the SKIPPED_NO_MATCH row. */
  intentRejected: boolean;
  intentClosedReason: IntentClosedReason | null;
}

// Frozen because this one object is shared by every reach miss in every result Map; a consumer mutating an entry must not corrupt them all.
const NOT_MATCHED: Readonly<CampaignMatch> = Object.freeze({
  matched: false,
  matchedKeyword: null,
  intentProbability: null,
  intentRejected: false,
  intentClosedReason: null,
});

/**
 * Reach, then meaning. Keyword matching decides which campaigns *consider*
 * the text; the intent gate decides, for those that ask for it, whether to
 * act. Every gated survivor goes into one provider call.
 *
 * Fails closed: no provider or no description rejects without a call; a
 * provider that refuses the request (bad key, no credit, unprocessable input) closes every gated
 * candidate and returns normally, since retrying cannot help; any other
 * provider error propagates so the caller's job retries and nothing is sent.
 */
export async function matchCampaigns({
  text,
  authorHandle,
  campaigns,
  provider,
}: {
  text: string;
  authorHandle: string | null;
  campaigns: MatchableCampaign[];
  provider: JudgmentProvider | null;
}): Promise<Map<string, Readonly<CampaignMatch>>> {
  const results = new Map<string, Readonly<CampaignMatch>>();
  const candidates: IntentCandidate[] = [];
  const reachKeyword = new Map<string, string | null>();

  for (const campaign of campaigns) {
    const reach = campaign.matchAnyWord
      ? { matched: true, matchedKeyword: null }
      : matchKeywords(text, campaign.keywords, campaign.wholeWordMatch);

    if (!reach.matched) {
      results.set(campaign.id, NOT_MATCHED);
      continue;
    }

    if (!campaign.intentGateEnabled) {
      results.set(campaign.id, { ...NOT_MATCHED, matched: true, matchedKeyword: reach.matchedKeyword });
      continue;
    }

    const offer = campaign.intentDescription?.trim() ?? "";
    if (!offer) {
      results.set(campaign.id, { ...NOT_MATCHED, intentRejected: true, intentClosedReason: "no_description" });
      continue;
    }
    if (!provider) {
      results.set(campaign.id, { ...NOT_MATCHED, intentRejected: true, intentClosedReason: "no_provider" });
      continue;
    }

    reachKeyword.set(campaign.id, reach.matchedKeyword);
    candidates.push({ campaignId: campaign.id, offer, threshold: campaign.intentThreshold });
  }

  // Non-empty candidates already implies a provider; the second operand only narrows the type.
  if (candidates.length > 0 && provider) {
    let verdicts: Awaited<ReturnType<typeof gateIntents>>;
    try {
      verdicts = await gateIntents({ comment: { text, authorHandle }, candidates }, provider);
    } catch (error) {
      if (!(error instanceof IntentJudgmentRejectedError)) throw error;
      for (const candidate of candidates) {
        results.set(candidate.campaignId, {
          matched: false,
          matchedKeyword: reachKeyword.get(candidate.campaignId) ?? null,
          intentProbability: null,
          intentRejected: true,
          intentClosedReason: "provider_rejected",
        });
      }
      return results;
    }
    for (const verdict of verdicts) {
      results.set(verdict.campaignId, {
        matched: verdict.outcome === "pass",
        matchedKeyword: reachKeyword.get(verdict.campaignId) ?? null,
        intentProbability: verdict.probability,
        intentRejected: verdict.outcome === "reject",
        intentClosedReason: null,
      });
    }
  }

  return results;
}
