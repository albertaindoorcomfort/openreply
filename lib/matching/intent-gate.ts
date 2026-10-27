import { noul, type NoulQuestion } from "@typesafe-ai/sdk";
import {
  IntentJudgmentUnavailableError,
  type IntentRequest,
  type JudgmentProvider,
} from "./judgment-provider";

export interface IntentCandidate {
  campaignId: string;
  /** The campaign's intentDescription — what it offers, in the owner's words. */
  offer: string;
  /** Probability of "yes" at or above which the gate passes. */
  threshold: number;
}

export interface IntentGateInput {
  comment: { text: string; authorHandle: string | null };
  candidates: IntentCandidate[];
}

export interface IntentVerdict {
  campaignId: string;
  outcome: "pass" | "reject";
  probability: number;
}

const YES =
  "The commenter is requesting the offer or asking how to get it — price, link, booking, availability, \"how do I\" — including when they also tag or address another user.";
const NO =
  "Anything else: general praise, an unrelated question, a complaint, a job or partnership inquiry, spam, a competitor, or a message that only talks to another commenter without asking for the offer.";

/**
 * One request for the whole comment. The state names every part so each
 * question can point at it; question ids are campaign ids and are for code —
 * the full meaning is in the instruction text and criteria.
 */
export function buildIntentRequest(input: IntentGateInput): IntentRequest {
  const campaigns: Record<string, { offer: string }> = {};
  const questions: Record<string, NoulQuestion> = {};

  for (const candidate of input.candidates) {
    campaigns[candidate.campaignId] = { offer: candidate.offer };
    questions[candidate.campaignId] = noul(
      `Does \`comment.text\` ask for, or express clear interest in receiving, what \`campaigns.${candidate.campaignId}.offer\` describes?`,
      { true: YES, false: NO }
    );
  }

  return {
    state: {
      // The handle is context, not a question target: it lets the model
      // weigh an obvious bot or competitor account.
      comment: { text: input.comment.text, authorHandle: input.comment.authorHandle },
      campaigns,
    },
    questions,
  };
}

/** Ask once, threshold per campaign. Throws IntentJudgmentUnavailableError rather than guessing. */
export async function gateIntents(
  input: IntentGateInput,
  provider: JudgmentProvider
): Promise<IntentVerdict[]> {
  if (input.candidates.length === 0) return [];

  const probabilities = await provider.judgeIntents(buildIntentRequest(input));

  return input.candidates.map((candidate) => {
    const probability = probabilities[candidate.campaignId];
    if (typeof probability !== "number") {
      throw new IntentJudgmentUnavailableError(
        `No intent probability returned for campaign ${candidate.campaignId}`
      );
    }
    return {
      campaignId: candidate.campaignId,
      outcome: probability >= candidate.threshold ? "pass" : "reject",
      probability,
    };
  });
}
