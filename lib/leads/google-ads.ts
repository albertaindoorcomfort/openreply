import { z } from "zod";
import { FormSubmissionSchema, toInboundEvent, type FormSubmission } from "./forms";

/**
 * Google Ads lead form webhooks. Google posts each lead as JSON to one URL and
 * proves it is the advertiser's form by the `google_key` set on the form, which
 * here is a forms:submit key. Google retries anything but a 200.
 */
export const GoogleAdsLeadSchema = z
  .object({
    lead_id: z.string().max(200),
    google_key: z.string().max(200),
    user_column_data: z
      .array(
        z.object({
          column_id: z.string().max(200).optional(),
          column_name: z.string().max(500).optional(),
          string_value: z.string().max(5000).optional(),
        })
      )
      .max(100)
      .default([]),
    form_id: z.union([z.string(), z.number()]).optional(),
    campaign_id: z.union([z.string(), z.number()]).optional(),
    adgroup_id: z.union([z.string(), z.number()]).optional(),
    creative_id: z.union([z.string(), z.number()]).optional(),
    gcl_id: z.string().max(500).optional(),
    is_test: z.boolean().default(false),
  })
  .passthrough();
export type GoogleAdsLead = z.infer<typeof GoogleAdsLeadSchema>;

// Google's column ids for contact fields; anything else is an answer to a form question.
const CONTACT_COLUMNS: Record<string, "name" | "firstName" | "lastName" | "email" | "phone" | "company"> = {
  FULL_NAME: "name",
  FIRST_NAME: "firstName",
  LAST_NAME: "lastName",
  EMAIL: "email",
  WORK_EMAIL: "email",
  PHONE_NUMBER: "phone",
  WORK_PHONE: "phone",
  COMPANY_NAME: "company",
};

const LABELS: Record<string, string> = {
  POSTAL_CODE: "Postal code",
  CITY: "City",
  REGION: "Province",
  COUNTRY: "Country",
  STREET_ADDRESS: "Address",
  JOB_TITLE: "Job title",
};

export function toGoogleAdsSubmission(lead: GoogleAdsLead): FormSubmission {
  const fields: Record<string, string> = {};
  const answers: string[] = [];
  for (const c of lead.user_column_data) {
    const value = c.string_value?.trim();
    if (!value) continue;
    const id = (c.column_id ?? "").toUpperCase();
    const field = CONTACT_COLUMNS[id];
    if (field && !fields[field]) fields[field] = value;
    else if (!field) answers.push(`${LABELS[id] ?? c.column_name ?? c.column_id ?? "Answer"}: ${value}`);
  }
  return FormSubmissionSchema.parse({
    ...fields,
    message: answers.join("\n"),
    subject: "Google Ads lead form",
    submission_id: `gads:${lead.lead_id}`.slice(0, 100),
  });
}

/** The inbound event for a Google Ads lead, with the ad that produced it as its source. */
export function googleAdsInboundEvent(lead: GoogleAdsLead, keyName: string, now = new Date()) {
  const event = toInboundEvent(toGoogleAdsSubmission(lead), keyName, now);
  const detail = [
    "Google Ads lead form",
    lead.form_id !== undefined ? `form ${lead.form_id}` : "",
    lead.campaign_id !== undefined ? `campaign ${lead.campaign_id}` : "",
    lead.adgroup_id !== undefined ? `ad group ${lead.adgroup_id}` : "",
    lead.gcl_id ? `gclid ${lead.gcl_id}` : "",
  ]
    .filter(Boolean)
    .join(", ")
    .slice(0, 300);
  return {
    ...event,
    // Asking for a quote through the ad is an inquiry: implied consent, as for the website form.
    consent: { ...event.consent, source: "Google Ads lead form inquiry", evidence: undefined },
    source: { detail },
  };
}
