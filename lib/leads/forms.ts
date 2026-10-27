import { createHash } from "node:crypto";
import { z } from "zod";
import { LeadError } from "./errors";

/**
 * Website form submissions. The page posts to /api/forms/<form key>; the key
 * can only submit forms, so exposing it in page source is safe.
 */
export const FormSubmissionSchema = z
  .object({
    name: z.string().trim().max(200).optional(),
    firstName: z.string().trim().max(100).optional(),
    lastName: z.string().trim().max(100).optional(),
    email: z.string().trim().max(320).optional(),
    phone: z.string().trim().max(40).optional(),
    company: z.string().trim().max(200).optional(),
    message: z.string().trim().max(10_000).default(""),
    subject: z.string().trim().max(300).optional(),
    /** "on", "true" or "yes" when the visitor ticked a marketing consent box. */
    consent: z.string().max(10).optional(),
    page: z.string().max(2000).optional(),
    utm_source: z.string().max(200).optional(),
    utm_medium: z.string().max(200).optional(),
    utm_campaign: z.string().max(200).optional(),
    campaign_ref: z.string().max(100).optional(),
    /** Honeypot: real people leave it empty. */
    website: z.string().max(500).optional(),
    /** Optional client-generated id so a double submit is stored once. */
    submission_id: z.string().max(100).optional(),
  })
  .strip();
export type FormSubmission = z.infer<typeof FormSubmissionSchema>;

export async function parseFormBody(request: Request): Promise<unknown> {
  const type = request.headers.get("content-type") ?? "";
  const text = await request.text();
  if (text.length > 64_000) throw new LeadError("PAYLOAD_TOO_LARGE", 413);
  if (type.includes("application/json")) return text ? JSON.parse(text) : {};
  return Object.fromEntries(new URLSearchParams(text));
}

export function toInboundEvent(form: FormSubmission, workspaceFormName: string, now = new Date()) {
  const identities = [
    ...(form.email ? [{ kind: "EMAIL" as const, value: form.email }] : []),
    ...(form.phone ? [{ kind: "PHONE" as const, value: form.phone }] : []),
  ];
  if (identities.length === 0) throw new LeadError("CONTACT_DETAILS_REQUIRED", 400, "Please give an email address or phone number.");
  const name = form.name || [form.firstName, form.lastName].filter(Boolean).join(" ") || undefined;
  // Without a client id, the same person sending the same text within a minute is one submission.
  const fingerprint =
    form.submission_id ??
    createHash("sha256").update([form.email, form.phone, form.message, Math.floor(now.getTime() / 60_000)].join("|")).digest("hex").slice(0, 32);
  const id = `form:${fingerprint}`;
  const consent = /^(on|true|yes|1)$/i.test(form.consent ?? "");
  const source = [form.utm_source, form.utm_medium, form.utm_campaign].filter(Boolean).join(" / ");
  return {
    channel: "WEB_FORM" as const,
    channelAccountRef: workspaceFormName,
    externalThreadId: id,
    externalMessageId: id,
    occurredAt: now,
    from: { displayName: name, firstName: form.firstName, lastName: form.lastName, company: form.company, identities },
    subject: form.subject ?? "Website inquiry",
    body: [form.message, form.page ? `\n(Sent from ${form.page})` : ""].join("").trim() || "(no message)",
    kind: "MESSAGE" as const,
    attachments: [],
    consent: consent
      ? { channel: "EMAIL" as const, basis: "EXPRESS" as const, status: "GRANTED" as const, source: "website form opt-in", evidence: form.page }
      : { channel: "EMAIL" as const, basis: "IMPLIED" as const, status: "GRANTED" as const, source: "website inquiry", evidence: form.page },
    source: { detail: source || form.page?.slice(0, 300), campaignRef: form.campaign_ref },
  };
}
