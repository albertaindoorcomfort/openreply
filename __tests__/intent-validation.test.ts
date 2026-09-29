import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  isIntentConfigValid,
  normalizeIntentThreshold,
} from "../lib/campaigns/intent-validation";

describe("isIntentConfigValid", () => {
  it("accepts gate off with no description", () => {
    expect(isIntentConfigValid({ intentGateEnabled: false })).toBe(true);
  });
  it("accepts gate on with a description", () => {
    expect(
      isIntentConfigValid({ intentGateEnabled: true, intentDescription: "A free quote" })
    ).toBe(true);
  });
  it("rejects gate on with null description", () => {
    expect(
      isIntentConfigValid({ intentGateEnabled: true, intentDescription: null })
    ).toBe(false);
  });
  it("rejects gate on with a blank description", () => {
    expect(
      isIntentConfigValid({ intentGateEnabled: true, intentDescription: "   " })
    ).toBe(false);
  });
  it("accepts gate undefined", () => {
    expect(isIntentConfigValid({})).toBe(true);
  });
});

describe("normalizeIntentThreshold", () => {
  it("removes float noise", () => {
    expect(normalizeIntentThreshold(0.9500000000000001)).toBe(0.95);
    expect(normalizeIntentThreshold(0.7000000000000001)).toBe(0.7);
    expect(normalizeIntentThreshold(0.5)).toBe(0.5);
  });

  it("lets a slider value pass the bounds check when piped before it", () => {
    const schema = z.object({
      intentThreshold: z
        .number()
        .transform(normalizeIntentThreshold)
        .pipe(z.number().min(0.5).max(0.95))
        .optional()
        .default(0.7),
    });
    expect(schema.parse({ intentThreshold: 0.05 * 19 }).intentThreshold).toBe(0.95);
    expect(schema.parse({}).intentThreshold).toBe(0.7);
    expect(schema.safeParse({ intentThreshold: 0.96 }).success).toBe(false);
  });
});
