import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    dmLog: {
      findMany: vi.fn(),
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import { resolveCampaignMatches, type MatchSource } from "../lib/queue/campaign-matching";
import {
  createFakeJudgmentProvider,
  IntentJudgmentRejectedError,
  IntentJudgmentUnavailableError,
} from "../lib/matching/judgment-provider";

const source: MatchSource = {
  dedupeId: "comment_1",
  text: "I want the LINK!",
  commenterId: "commenter_1",
  commenterName: "commenter_user",
};

function campaign(overrides: Record<string, unknown> = {}) {
  return {
    id: "kw_1",
    workspaceId: "ws_1",
    instagramAccountId: "ig_row_1",
    keywords: ["LINK"],
    matchAnyWord: false,
    wholeWordMatch: true,
    intentGateEnabled: false,
    intentDescription: null as string | null,
    intentThreshold: 0.7,
    ...overrides,
  };
}

function gated(id = "gated_1") {
  return campaign({
    id,
    keywords: [],
    matchAnyWord: true,
    intentGateEnabled: true,
    intentDescription: "a free furnace tune-up booking link",
  });
}

function row(automationId: string, status: string, intentProbability: number | null, matchedKeyword: string | null = null) {
  return { automationId, status, matchedKeyword, intentProbability };
}

const closureWhere = (automationId: string) => ({
  automationId,
  commentId: "comment_1",
  status: "SKIPPED_NO_MATCH",
  intentProbability: null,
});

beforeEach(() => {
  mockPrisma.dmLog.findMany.mockReset().mockResolvedValue([]);
  mockPrisma.dmLog.upsert.mockReset().mockResolvedValue({});
  mockPrisma.dmLog.updateMany.mockReset().mockResolvedValue({ count: 1 });
});

function expectNoWrites() {
  expect(mockPrisma.dmLog.upsert).not.toHaveBeenCalled();
  expect(mockPrisma.dmLog.updateMany).not.toHaveBeenCalled();
}

describe("resolveCampaignMatches", () => {
  it("matches an ungated keyword hit with no provider call and no writes", async () => {
    const provider = createFakeJudgmentProvider({});
    const result = await resolveCampaignMatches({ source, automations: [campaign()], provider });

    expect(result.matched.get("kw_1")).toEqual({ matchedKeyword: "LINK", intentProbability: null });
    expect(result.deferredError).toBeNull();
    expect(provider.calls).toHaveLength(0);
    expectNoWrites();
  });

  it("reads existing rows once, scoped to this comment and these campaigns", async () => {
    await resolveCampaignMatches({ source, automations: [campaign(), gated()], provider: null });

    expect(mockPrisma.dmLog.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.dmLog.findMany).toHaveBeenCalledWith({
      where: { commentId: "comment_1", automationId: { in: ["kw_1", "gated_1"] } },
      select: { automationId: true, status: true, matchedKeyword: true, intentProbability: true },
    });
  });

  it("matches a gated pass with its probability, one call, no writes", async () => {
    const provider = createFakeJudgmentProvider({ gated_1: 0.91 });
    const result = await resolveCampaignMatches({ source, automations: [gated()], provider });

    expect(result.matched.get("gated_1")).toEqual({ matchedKeyword: null, intentProbability: 0.91 });
    expect(provider.calls).toHaveLength(1);
    expectNoWrites();
  });

  it("records a gated rejection create-only and does not match it", async () => {
    const provider = createFakeJudgmentProvider({ gated_1: 0.12 });
    const result = await resolveCampaignMatches({ source, automations: [gated()], provider });

    expect(result.matched.has("gated_1")).toBe(false);
    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledTimes(1);
    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith({
      where: { automationId_commentId: { automationId: "gated_1", commentId: "comment_1" } },
      create: {
        workspaceId: "ws_1",
        automationId: "gated_1",
        instagramAccountId: "ig_row_1",
        commenterId: "commenter_1",
        commenterName: "commenter_user",
        commentText: "I want the LINK!",
        commentId: "comment_1",
        matchedKeyword: null,
        status: "SKIPPED_NO_MATCH",
        intentProbability: 0.12,
        errorMessage: "Intent gate rejected this comment (p=0.12)",
      },
      update: {},
    });
    // The follow-up closure-row fix-up is guarded to closure rows only.
    expect(mockPrisma.dmLog.updateMany).toHaveBeenCalledWith({
      where: closureWhere("gated_1"),
      data: { intentProbability: 0.12, errorMessage: "Intent gate rejected this comment (p=0.12)" },
    });
  });

  it("treats a recorded rejection as final: no call, no write, not matched", async () => {
    mockPrisma.dmLog.findMany.mockResolvedValue([row("gated_1", "SKIPPED_NO_MATCH", 0.1)]);
    const provider = createFakeJudgmentProvider({ gated_1: 0.99 });
    const result = await resolveCampaignMatches({ source, automations: [gated()], provider });

    expect(result.matched.has("gated_1")).toBe(false);
    expect(provider.calls).toHaveLength(0);
    expectNoWrites();
  });

  it("reuses a SENT row's stored verdict without asking the provider again", async () => {
    mockPrisma.dmLog.findMany.mockResolvedValue([row("gated_1", "SENT", 0.88, "LINK")]);
    const provider = createFakeJudgmentProvider({ gated_1: 0.99 });
    const result = await resolveCampaignMatches({ source, automations: [gated()], provider });

    expect(result.matched.get("gated_1")).toEqual({ matchedKeyword: "LINK", intentProbability: 0.88 });
    expect(provider.calls).toHaveLength(0);
    expectNoWrites();
  });

  it("never writes to an already-decided row even when the provider would now reject", async () => {
    for (const status of ["SENT", "PENDING", "FAILED"]) {
      mockPrisma.dmLog.findMany.mockResolvedValue([row("gated_1", status, 0.88)]);
      const provider = createFakeJudgmentProvider({ gated_1: 0.01 });
      const result = await resolveCampaignMatches({ source, automations: [gated()], provider });

      expect(result.matched.has("gated_1")).toBe(true);
      expectNoWrites();
    }
  });

  it("judges a closure row for real once a provider exists, and promotes it on a pass", async () => {
    mockPrisma.dmLog.findMany.mockResolvedValue([row("gated_1", "SKIPPED_NO_MATCH", null)]);
    const provider = createFakeJudgmentProvider({ gated_1: 0.8 });
    const result = await resolveCampaignMatches({ source, automations: [gated()], provider });

    expect(provider.calls).toHaveLength(1);
    expect(result.matched.get("gated_1")).toEqual({ matchedKeyword: null, intentProbability: 0.8 });
    expect(mockPrisma.dmLog.updateMany).toHaveBeenCalledWith({
      where: closureWhere("gated_1"),
      data: { status: "PENDING", intentProbability: 0.8, errorMessage: null, matchedKeyword: null },
    });
    expect(mockPrisma.dmLog.upsert).not.toHaveBeenCalled();
  });

  it("turns a closure row into a real rejection when the provider now rejects", async () => {
    mockPrisma.dmLog.findMany.mockResolvedValue([row("gated_1", "SKIPPED_NO_MATCH", null)]);
    const provider = createFakeJudgmentProvider({ gated_1: 0.2 });
    const result = await resolveCampaignMatches({ source, automations: [gated()], provider });

    expect(result.matched.has("gated_1")).toBe(false);
    expect(mockPrisma.dmLog.updateMany).toHaveBeenCalledWith({
      where: closureWhere("gated_1"),
      data: { intentProbability: 0.2, errorMessage: "Intent gate rejected this comment (p=0.20)" },
    });
  });

  it("records a visible closure row when no provider is configured", async () => {
    const result = await resolveCampaignMatches({ source, automations: [gated()], provider: null });

    expect(result.matched.has("gated_1")).toBe(false);
    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: "SKIPPED_NO_MATCH",
          intentProbability: null,
          errorMessage: "Intent gate closed: no usable TypeSafe key is configured",
        }),
        update: {},
      })
    );
    // A closure carries no probability, so there is nothing to fix up.
    expect(mockPrisma.dmLog.updateMany).not.toHaveBeenCalled();
  });

  const rejectedMessage = "Intent gate closed: TypeSafe refused the request — check the API key, account and model setting";
  const rejectingProvider = () =>
    createFakeJudgmentProvider(() => {
      throw new IntentJudgmentRejectedError("TypeSafe rejected the request (AuthenticationError: 401)");
    });

  it("records a closure and completes normally when the provider rejects the request", async () => {
    const result = await resolveCampaignMatches({
      source,
      automations: [campaign(), gated()],
      provider: rejectingProvider(),
    });

    expect(result.deferredError).toBeNull();
    expect(result.matched.get("kw_1")).toEqual({ matchedKeyword: "LINK", intentProbability: null });
    expect(result.matched.has("gated_1")).toBe(false);
    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledTimes(1);
    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { automationId_commentId: { automationId: "gated_1", commentId: "comment_1" } },
        create: expect.objectContaining({
          status: "SKIPPED_NO_MATCH",
          intentProbability: null,
          errorMessage: rejectedMessage,
        }),
        update: {},
      })
    );
  });

  it("refreshes an existing closure row's reason, guarded to closure rows only", async () => {
    mockPrisma.dmLog.findMany.mockResolvedValue([row("gated_1", "SKIPPED_NO_MATCH", null)]);
    const result = await resolveCampaignMatches({
      source,
      automations: [gated()],
      provider: rejectingProvider(),
    });

    expect(result.deferredError).toBeNull();
    expect(result.matched.has("gated_1")).toBe(false);
    expect(mockPrisma.dmLog.updateMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.dmLog.updateMany).toHaveBeenCalledWith({
      where: closureWhere("gated_1"),
      data: { errorMessage: rejectedMessage },
    });
  });

  it("serves ungated campaigns during a provider outage and defers the error", async () => {
    const outage = new IntentJudgmentUnavailableError("TypeSafe request failed: 503");
    const provider = createFakeJudgmentProvider(() => {
      throw outage;
    });
    const result = await resolveCampaignMatches({
      source,
      automations: [campaign(), gated()],
      provider,
    });

    expect(result.deferredError).toBe(outage);
    expect(result.matched.get("kw_1")).toEqual({ matchedKeyword: "LINK", intentProbability: null });
    expect(result.matched.has("gated_1")).toBe(false);
    expect(provider.calls).toHaveLength(1);
    expectNoWrites();
  });

  it("propagates any other provider error", async () => {
    const provider = createFakeJudgmentProvider(() => {
      throw new TypeError("bug");
    });

    await expect(
      resolveCampaignMatches({ source, automations: [campaign(), gated()], provider })
    ).rejects.toThrow(TypeError);
    expectNoWrites();
  });

  it("asks the provider once however many gated campaigns are active", async () => {
    const provider = createFakeJudgmentProvider({ g1: 0.9, g2: 0.1, g3: 0.75 });
    const result = await resolveCampaignMatches({
      source,
      automations: [gated("g1"), gated("g2"), gated("g3")],
      provider,
    });

    expect(provider.calls).toHaveLength(1);
    expect(Object.keys(provider.calls[0].questions).sort()).toEqual(["g1", "g2", "g3"]);
    expect([...result.matched.keys()].sort()).toEqual(["g1", "g3"]);
  });

  it("does nothing for an empty campaign list", async () => {
    const result = await resolveCampaignMatches({ source, automations: [], provider: null });

    expect(result.matched.size).toBe(0);
    expect(mockPrisma.dmLog.findMany).not.toHaveBeenCalled();
  });
});
