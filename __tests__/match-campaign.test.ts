import { describe, expect, it } from "vitest";
import { matchCampaigns, type MatchableCampaign } from "../lib/matching/match-campaign";
import { matchKeywords } from "../lib/utils/keyword-matcher";
import {
  createFakeJudgmentProvider,
  IntentJudgmentRejectedError,
  IntentJudgmentUnavailableError,
} from "../lib/matching/judgment-provider";

function campaign(overrides: Partial<MatchableCampaign> = {}): MatchableCampaign {
  return {
    id: "c1",
    keywords: ["LINK"],
    matchAnyWord: false,
    wholeWordMatch: true,
    intentGateEnabled: false,
    intentDescription: null,
    intentThreshold: 0.7,
    ...overrides,
  };
}

const gated = campaign({
  id: "g1",
  matchAnyWord: true,
  intentGateEnabled: true,
  intentDescription: "a free furnace tune-up booking link",
});

describe("matchCampaigns — gate off", () => {
  it("is identical to matchKeywords for every fixture and never calls the provider", async () => {
    const provider = createFakeJudgmentProvider({});
    const fixtures = ["I want the LINK!", "linking is fun", "no thanks", "LİNK"];
    for (const text of fixtures) {
      const result = await matchCampaigns({ text, authorHandle: null, campaigns: [campaign()], provider });
      const expected = matchKeywords(text, ["LINK"], true);
      expect(result.get("c1")).toEqual({
        matched: expected.matched,
        matchedKeyword: expected.matchedKeyword,
        intentProbability: null,
        intentRejected: false,
        intentClosedReason: null,
      });
    }
    expect(provider.calls).toHaveLength(0);
  });

  it("matchAnyWord with the gate off fires on anything", async () => {
    const result = await matchCampaigns({
      text: "lovely", authorHandle: null,
      campaigns: [campaign({ matchAnyWord: true })], provider: null,
    });
    expect(result.get("c1")?.matched).toBe(true);
  });
});

describe("matchCampaigns — gate on", () => {
  it("passes and records the probability at or above threshold", async () => {
    const provider = createFakeJudgmentProvider({ g1: 0.83 });
    const result = await matchCampaigns({ text: "how much?", authorHandle: "sam", campaigns: [gated], provider });
    expect(result.get("g1")).toEqual({
      matched: true, matchedKeyword: null, intentProbability: 0.83,
      intentRejected: false, intentClosedReason: null,
    });
  });

  it("rejects below threshold and flags it as an intent rejection", async () => {
    const provider = createFakeJudgmentProvider({ g1: 0.2 });
    const result = await matchCampaigns({ text: "are you hiring", authorHandle: null, campaigns: [gated], provider });
    expect(result.get("g1")).toEqual({
      matched: false, matchedKeyword: null, intentProbability: 0.2,
      intentRejected: true, intentClosedReason: null,
    });
  });

  it("gates only keyword hits when keywords are set", async () => {
    const provider = createFakeJudgmentProvider({ k1: 0.9 });
    const withKeyword = campaign({ id: "k1", keywords: ["info"], intentGateEnabled: true, intentDescription: "pricing sheet" });
    const miss = await matchCampaigns({ text: "nice truck", authorHandle: null, campaigns: [withKeyword], provider });
    expect(miss.get("k1")?.matched).toBe(false);
    expect(provider.calls).toHaveLength(0);
    const hit = await matchCampaigns({ text: "info please", authorHandle: null, campaigns: [withKeyword], provider });
    expect(hit.get("k1")).toMatchObject({ matched: true, matchedKeyword: "info", intentProbability: 0.9 });
    expect(provider.calls).toHaveLength(1);
  });

  it("makes exactly one provider call for many gated campaigns", async () => {
    const provider = createFakeJudgmentProvider({ g1: 0.9, g2: 0.1, g3: 0.75 });
    const campaigns = [
      gated,
      { ...gated, id: "g2", intentDescription: "job postings" },
      { ...gated, id: "g3", intentDescription: "service-area map", intentThreshold: 0.75 },
    ];
    const result = await matchCampaigns({ text: "how much?", authorHandle: null, campaigns, provider });
    expect(provider.calls).toHaveLength(1);
    expect(Object.keys(provider.calls[0].questions).sort()).toEqual(["g1", "g2", "g3"]);
    expect(result.get("g1")?.matched).toBe(true);
    expect(result.get("g2")?.matched).toBe(false);
    expect(result.get("g3")?.matched).toBe(true);
  });

  it("mixes an ungated hit with gated pass and reject in one call", async () => {
    const provider = createFakeJudgmentProvider({ g1: 0.9, g2: 0.1 });
    const ungated = campaign({ id: "u1", keywords: ["LINK"] });
    const campaigns = [ungated, gated, { ...gated, id: "g2", intentDescription: "job postings" }];
    const result = await matchCampaigns({ text: "send the LINK", authorHandle: "sam", campaigns, provider });
    expect(provider.calls).toHaveLength(1);
    expect(Object.keys(provider.calls[0].questions).sort()).toEqual(["g1", "g2"]);
    expect(result.get("u1")).toEqual({
      matched: true, matchedKeyword: "LINK", intentProbability: null,
      intentRejected: false, intentClosedReason: null,
    });
    expect(result.get("g1")?.matched).toBe(true);
    expect(result.get("g2")).toMatchObject({ matched: false, intentRejected: true });
    expect(provider.calls[0].state).toMatchObject({
      comment: { text: "send the LINK", authorHandle: "sam" },
    });
  });

  it("propagates provider failure so nothing is sent", async () => {
    const provider = createFakeJudgmentProvider(() => {
      throw new IntentJudgmentUnavailableError("down");
    });
    await expect(
      matchCampaigns({ text: "how much?", authorHandle: null, campaigns: [gated], provider })
    ).rejects.toBeInstanceOf(IntentJudgmentUnavailableError);
  });

  it("closes gated campaigns and still serves ungated ones when the provider rejects the request", async () => {
    const provider = createFakeJudgmentProvider(() => {
      throw new IntentJudgmentRejectedError("TypeSafe rejected the request (AuthenticationError: 401)");
    });
    const ungated = campaign({ id: "u1", keywords: ["LINK"] });
    const keywordGated = campaign({
      id: "g2", keywords: ["LINK"], intentGateEnabled: true, intentDescription: "job postings",
    });
    const result = await matchCampaigns({
      text: "send the LINK", authorHandle: null, campaigns: [ungated, gated, keywordGated], provider,
    });
    expect(result.get("g1")).toEqual({
      matched: false, matchedKeyword: null, intentProbability: null,
      intentRejected: true, intentClosedReason: "provider_rejected",
    });
    expect(result.get("g2")).toEqual({
      matched: false, matchedKeyword: "LINK", intentProbability: null,
      intentRejected: true, intentClosedReason: "provider_rejected",
    });
    expect(result.get("u1")).toMatchObject({ matched: true, matchedKeyword: "LINK" });
  });

  it("is closed without a provider, with no call and a visible reason", async () => {
    const result = await matchCampaigns({ text: "how much?", authorHandle: null, campaigns: [gated], provider: null });
    expect(result.get("g1")).toEqual({
      matched: false, matchedKeyword: null, intentProbability: null,
      intentRejected: true, intentClosedReason: "no_provider",
    });
  });

  it("is closed for a gated campaign with no description, without calling the provider", async () => {
    const provider = createFakeJudgmentProvider({ g1: 0.99 });
    const result = await matchCampaigns({
      text: "how much?", authorHandle: null,
      campaigns: [{ ...gated, intentDescription: "   " }], provider,
    });
    expect(result.get("g1")).toMatchObject({ matched: false, intentRejected: true, intentClosedReason: "no_description" });
    expect(provider.calls).toHaveLength(0);
  });
});
