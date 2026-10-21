import type { IdentityKind } from "@/app/generated/prisma/client";

const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

/**
 * Canonical form of an identity value, so the same person matches across
 * channels. Returns null for a value that cannot identify anyone.
 */
export function normalizeIdentity(kind: IdentityKind, raw: string): string | null {
  const value = raw.trim();
  if (!value || value.length > 320) return null;
  switch (kind) {
    case "EMAIL": {
      const email = value.toLowerCase();
      return EMAIL.test(email) ? email : null;
    }
    case "PHONE":
      return normalizePhone(value);
    default:
      return value;
  }
}

/** E.164. Bare 10-digit numbers are North American, which is where AIC operates. */
export function normalizePhone(raw: string): string | null {
  const hasPlus = raw.trim().startsWith("+");
  const digits = raw.replace(/\D/g, "");
  if (hasPlus) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** Lower-case words for name comparison: "Jordan  Lee" and "jordan lee" match. */
export function nameKey(name: string | null | undefined): string {
  return (name ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
