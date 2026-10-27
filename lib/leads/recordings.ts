/**
 * Call recordings attached to inbox messages. The attachment names the voice
 * provider's authenticated per-call recording route; staff hear it through the
 * inbox's own route, which asks the provider for a short-lived signed link at
 * play time, so the browser never fetches an arbitrary URL.
 */

export type Attachment = { name: string; url: string; contentType?: string };

const RECORDING_ROUTE = /^\/call\/[A-Za-z0-9_-]{1,100}\/(mono|stereo)-recording$/;

export function playableUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === "api.vapi.ai" && !u.search && RECORDING_ROUTE.test(u.pathname) ? u.toString() : null;
  } catch {
    return null;
  }
}

// The provider's signed links point at its own storage: its R2 account or its own domain.
const VAPI_R2_HOST = "94bdb67bb98da30b06bdd917725c037d.r2.cloudflarestorage.com";

/** Whether a signed link the provider redirected to is on its own storage. */
export function signedStorageUrl(location: string | null): string | null {
  if (!location) return null;
  try {
    const u = new URL(location);
    const host = u.hostname;
    return u.protocol === "https:" && (host === VAPI_R2_HOST || host === "vapi.ai" || host.endsWith(".vapi.ai")) ? u.toString() : null;
  } catch {
    return null;
  }
}

/** The audio attachments on a message that the inbox can play, keeping their index. */
export function recordings(attachments: unknown): { index: number; name: string }[] {
  if (!Array.isArray(attachments)) return [];
  return attachments.flatMap((a, index) => {
    const x = a as Partial<Attachment>;
    return typeof x?.url === "string" && x.contentType?.startsWith("audio/") && playableUrl(x.url) ? [{ index, name: x.name ?? "Recording" }] : [];
  });
}
