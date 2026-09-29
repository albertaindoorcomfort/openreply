import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    webhookEvent: { findMany: vi.fn() },
    dmLog: { findMany: vi.fn() },
    operationalEvent: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", () => ({ getCurrentWorkspaceId: vi.fn().mockResolvedValue("ws_1") }));
vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => ({ getJobCounts: vi.fn().mockResolvedValue({}) }),
}));
vi.mock("@/lib/ops/worker-health", () => ({
  getWorkerHealth: vi.fn().mockResolvedValue(null),
  getWorkerAlerts: vi.fn().mockResolvedValue([]),
}));

import { GET } from "../app/api/admin/diagnostics/route";

beforeEach(() => {
  mockPrisma.webhookEvent.findMany.mockReset().mockResolvedValue([]);
  mockPrisma.dmLog.findMany.mockReset().mockResolvedValue([]);
  mockPrisma.operationalEvent.findMany.mockReset().mockResolvedValue([]);
});

describe("admin diagnostics", () => {
  it("lists intent-gate closures as problems but not judged rejections", async () => {
    const response = await GET();
    expect(response.status).toBe(200);

    expect(mockPrisma.dmLog.findMany).toHaveBeenCalledTimes(1);
    const [{ where }] = mockPrisma.dmLog.findMany.mock.calls[0];
    expect(where).toEqual({
      workspaceId: "ws_1",
      OR: [
        { status: { in: ["FAILED", "SKIPPED_RATE_LIMIT", "SKIPPED_PLAN_LIMIT"] } },
        { status: "SKIPPED_NO_MATCH", intentProbability: null },
      ],
    });
  });
});
