import { describe, expect, it } from "vitest";
import { buildIntentRequest, gateIntents } from "../lib/matching/intent-gate";
import {
  createFakeJudgmentProvider,
  IntentJudgmentUnavailableError,
} from "../lib/matching/judgment-provider";

const input = {
  comment: { text: "how much is the tune up?", authorHandle: "sam_yyc" },
  candidates: [
    { campaignId: "c_tuneup", offer: "a free furnace tune-up booking link", threshold: 0.7 },
    { campaignId: "c_hiring", offer: "a link to open technician job postings", threshold: 0.6 },
  ],
};

describe("buildIntentRequest", () => {
  it("puts the comment and every offer in named state, one noul per campaign", () => {
    const request = buildIntentRequest(input);
    expect(request.state).toEqual({
      comment: { text: "how much is the tune up?", authorHandle: "sam_yyc" },
      campaigns: {
        c_tuneup: { offer: "a free furnace tune-up booking link" },
        c_hiring: { offer: "a link to open technician job postings" },
      },
    });
    expect(Object.keys(request.questions)).toEqual(["c_tuneup", "c_hiring"]);
    const q = request.questions.c_tuneup;
    expect(q.type).toBe("noul");
    expect(String(q.instructions)).toContain("`comment.text`");
    expect(String(q.instructions)).toContain("`campaigns.c_tuneup.offer`");
    expect(q.criteria?.true).toBeTruthy();
    expect(q.criteria?.false).toBeTruthy();
  });

  it("allows a null author handle", () => {
    const request = buildIntentRequest({ ...input, comment: { text: "x", authorHandle: null } });
    expect((request.state as { comment: { authorHandle: null } }).comment.authorHandle).toBeNull();
  });
});

describe("gateIntents", () => {
  it("passes at or above each campaign's own threshold and rejects below", async () => {
    const provider = createFakeJudgmentProvider({ c_tuneup: 0.7, c_hiring: 0.59 });
    await expect(gateIntents(input, provider)).resolves.toEqual([
      { campaignId: "c_tuneup", outcome: "pass", probability: 0.7 },
      { campaignId: "c_hiring", outcome: "reject", probability: 0.59 },
    ]);
    expect(provider.calls).toHaveLength(1);
  });

  it("makes no call for zero candidates", async () => {
    const provider = createFakeJudgmentProvider({});
    await expect(gateIntents({ ...input, candidates: [] }, provider)).resolves.toEqual([]);
    expect(provider.calls).toHaveLength(0);
  });

  it("fails closed when a probability is missing", async () => {
    const provider = createFakeJudgmentProvider({ c_tuneup: 0.9 });
    await expect(gateIntents(input, provider)).rejects.toBeInstanceOf(
      IntentJudgmentUnavailableError
    );
  });
});
