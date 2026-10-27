import { createFlowWithGrant, listFlows } from "@/lib/automation/flows-api";
import { LeadError } from "@/lib/leads/errors";
import { json, route, serviceActor } from "@/lib/leads/http";

/** Relay's flows with their results. Needs flows:read. */
export const GET = route(async (request) => {
  const actor = await serviceActor(request, "flows:read");
  const limit = Number(request.nextUrl.searchParams.get("limit") ?? 20);
  return json({ flows: await listFlows(actor.workspaceId, Number.isInteger(limit) ? limit : 20) });
});

/**
 * Creates a flow a person approved in Apollo. Needs flows:write and an
 * x-flow-grant flow grant over the exact body. 4xx is final.
 */
export const POST = route(async (request) => {
  const actor = await serviceActor(request, "flows:write");
  const grant = request.headers.get("x-flow-grant");
  if (!grant) throw new LeadError("GRANT_MISSING", 403);
  const raw = await request.text();
  if (raw.length > 32_000) throw new LeadError("PAYLOAD_TOO_LARGE", 413);
  const out = await createFlowWithGrant(actor.workspaceId, raw, grant);
  return json(out, out.replay ? 200 : 201);
});
