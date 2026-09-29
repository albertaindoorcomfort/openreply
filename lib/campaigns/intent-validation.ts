/** A gated campaign needs a non-blank description: the gate has nothing to judge against otherwise. */
export function isIntentConfigValid(input: {
  intentGateEnabled?: boolean | null;
  intentDescription?: string | null;
}): boolean {
  return !input.intentGateEnabled || Boolean(input.intentDescription?.trim());
}

export const INTENT_DESCRIPTION_REQUIRED =
  "Describe what the campaign offers, or turn off the intent check";

/** Sliders produce float noise (0.05 * 19 = 0.9500000000000001); thresholds are meaningful to two decimals. */
export function normalizeIntentThreshold(value: number): number {
  return Math.round(value * 100) / 100;
}
