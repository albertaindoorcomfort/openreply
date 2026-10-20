import { z } from "zod";
import { sendDraftWithGrant } from "@/lib/leads/drafts";
import { LeadError } from "@/lib/leads/errors";
import { json, readJson, route, serviceActor } from "@/lib/leads/http";

type Ctx = { params: Promise<{ id: string }> };
const Body = z.object({ workspaceId: z.string().max(100).optional() }).passthrough();

/**
 * Apollo releases an approved draft. Contract: docs/lead-model.md and Apollo's
 * contracts.md section 13. 4xx is final; only our own failures return 5xx.
 */
export const POST = route<Ctx>(async (request, { params }) => {
  const actor = await serviceActor(request, "messages:send");
  const grant = request.headers.get("x-relay-grant");
  if (!grant) throw new LeadError("GRANT_MISSING", 403);
  const body = Body.parse(await readJson(request));
  if (body.workspaceId && body.workspaceId !== actor.workspaceId) throw new LeadError("GRANT_WRONG_WORKSPACE", 403);
  const result = await sendDraftWithGrant(actor, (await params).id, grant);
  if (result.status === "SENT") return json(result);
  const { error: detail, ...rest } = result;
  if (result.status === "SEND_UNCONFIRMED") return json({ ...rest, error: "SEND_UNCONFIRMED", detail }, 409);
  if (result.status === "FAILED") return json({ ...rest, error: "PROVIDER_REJECTED", detail }, 422);
  // SENDING: a concurrent request with this approval is mid-flight.
  return json({ ...rest, error: "SEND_IN_PROGRESS", detail }, 409);
});
