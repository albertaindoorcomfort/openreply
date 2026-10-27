/**
 * Call recordings attached to inbox messages. Only https links on the voice
 * provider's own storage are played, and staff hear them through the inbox's
 * own route, so the browser never fetches an arbitrary URL.
 */

export type Attachment = { name: string; url: string; contentType?: string };

// The voice provider stores recordings on its own Cloudflare R2 account; only that host, not R2 in general.
const VAPI_R2_HOST = "94bdb67bb98da30b06bdd917725c037d.r2.cloudflarestorage.com";
const ALLOWED_HOST = (host: string) => host === "vapi.ai" || host.endsWith(".vapi.ai") || host === VAPI_R2_HOST;

export function playableUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && ALLOWED_HOST(u.hostname) ? u.toString() : null;
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
