import { NextResponse, type NextRequest } from "next/server";
import { verifyApiKey } from "@/lib/leads/keys";
import { ingestInbound } from "@/lib/leads/ingest";
import { enqueueCarla } from "@/lib/leads/queue";
import { parseFormBody } from "@/lib/leads/forms";
import { GoogleAdsLeadSchema, googleAdsInboundEvent } from "@/lib/leads/google-ads";
import { clientIp, errorResponse, rateLimit } from "@/lib/leads/http";
import { LeadError } from "@/lib/leads/errors";

/**
 * Google Ads lead form webhook. The form's webhook URL is this route and its
 * key is a forms:submit key; the lead lands in the inbox like a website form.
 * Google's "Send test data" leads prove the key and store nothing.
 */
export async function POST(request: NextRequest) {
  try {
    await rateLimit(`gads-ip:${clientIp(request)}`, 120, 60);
    const lead = GoogleAdsLeadSchema.parse(await parseFormBody(request));
    const key = await verifyApiKey(lead.google_key);
    if (!key || !key.scopes.includes("forms:submit")) throw new LeadError("UNKNOWN_FORM", 401);
    await rateLimit(`form-key:${key.keyId}`, 120, 60);
    if (lead.is_test) return NextResponse.json({ ok: true, test: true });
    const actor = { kind: "SERVICE" as const, id: `form:${key.name}`, workspaceId: key.workspaceId };
    const result = await ingestInbound(actor, googleAdsInboundEvent(lead, key.name));
    if (!result.duplicate) {
      await enqueueCarla({ workspaceId: key.workspaceId, conversationId: result.conversationId, messageId: result.messageId });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
