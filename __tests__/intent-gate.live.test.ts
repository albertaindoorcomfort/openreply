/**
 * Runs against the real TypeSafe API. Paid. Skipped unless BOTH are set:
 *   TYPESAFE_API_KEY=...  TYPESAFE_LIVE_TEST=1  npx vitest run __tests__/intent-gate.live.test.ts
 *
 * Assertions compare booleans and thresholds only, so a failure can never
 * print the key or anything derived from it.
 */
import { describe, expect, it } from "vitest";
import { matchCampaigns } from "../lib/matching/match-campaign";
import { getJudgmentProvider } from "../lib/matching/judgment-provider";

const live = process.env.TYPESAFE_LIVE_TEST === "1" && Boolean(process.env.TYPESAFE_API_KEY);

describe.skipIf(!live)("intent gate — live Jev", () => {
  const tuneUp = {
    id: "live_tuneup",
    keywords: [],
    matchAnyWord: true,
    wholeWordMatch: true,
    intentGateEnabled: true,
    intentDescription: "a free furnace tune-up booking link for Calgary homeowners",
    intentThreshold: 0.7,
  };

  async function judge(text: string) {
    const provider = getJudgmentProvider();
    expect(provider !== null).toBe(true);
    const result = await matchCampaigns({ text, authorHandle: null, campaigns: [tuneUp], provider });
    return result.get("live_tuneup")!;
  }

  it("passes a clear request", async () => {
    const verdict = await judge("how do I book the free tune up?");
    console.log(`[live] request       p=${verdict.intentProbability?.toFixed(3)}`);
    expect(verdict.matched).toBe(true);
  }, 30_000);

  it("rejects a job inquiry", async () => {
    const verdict = await judge("are you guys hiring apprentices?");
    console.log(`[live] job inquiry   p=${verdict.intentProbability?.toFixed(3)}`);
    expect(verdict.matched).toBe(false);
  }, 30_000);

  it("passes a request that also tags a friend", async () => {
    const verdict = await judge("@bestie omg how much is this??");
    console.log(`[live] tag + request p=${verdict.intentProbability?.toFixed(3)}`);
    expect(verdict.matched).toBe(true);
  }, 30_000);
});
