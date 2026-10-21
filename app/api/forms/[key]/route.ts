import { NextResponse, type NextRequest } from "next/server";
import { verifyApiKey } from "@/lib/leads/keys";
import { ingestInbound } from "@/lib/leads/ingest";
import { enqueueCarla } from "@/lib/leads/queue";
import { FormSubmissionSchema, parseFormBody, toInboundEvent } from "@/lib/leads/forms";
import { clientIp, errorResponse, rateLimit } from "@/lib/leads/http";
import { LeadError } from "@/lib/leads/errors";

/** Thank-you pages may only be on hosts listed in LEADS_FORM_REDIRECT_HOSTS. */
function isAllowedRedirect(target: string) {
  const hosts = (process.env.LEADS_FORM_REDIRECT_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  try {
    const url = new URL(target);
    return url.protocol === "https:" && hosts.includes(url.host.toLowerCase());
  } catch {
    return false;
  }
}

type Ctx = { params: Promise<{ key: string }> };

const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" };

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: cors });
}

/** Public website form endpoint. Accepts JSON or a plain HTML form post. */
export async function POST(request: NextRequest, { params }: Ctx) {
  try {
    await rateLimit(`form-ip:${clientIp(request)}`, 10, 60);
    const key = await verifyApiKey((await params).key);
    if (!key || !key.scopes.includes("forms:submit")) throw new LeadError("UNKNOWN_FORM", 404);
    await rateLimit(`form-key:${key.keyId}`, 120, 60);
    const form = FormSubmissionSchema.parse(await parseFormBody(request));
    // Bots fill the hidden field. Answer as if it worked and store nothing.
    if (form.website) return NextResponse.json({ ok: true }, { status: 201, headers: cors });
    const actor = { kind: "SERVICE" as const, id: `form:${key.name}`, workspaceId: key.workspaceId };
    const result = await ingestInbound(actor, toInboundEvent(form, key.name));
    if (!result.duplicate) {
      await enqueueCarla({ workspaceId: key.workspaceId, conversationId: result.conversationId, messageId: result.messageId });
    }
    const redirect = request.nextUrl.searchParams.get("redirect");
    if (redirect && isAllowedRedirect(redirect) && !(request.headers.get("content-type") ?? "").includes("json")) {
      return NextResponse.redirect(redirect, 303);
    }
    return NextResponse.json({ ok: true }, { status: 201, headers: cors });
  } catch (err) {
    const res = errorResponse(err);
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  }
}
