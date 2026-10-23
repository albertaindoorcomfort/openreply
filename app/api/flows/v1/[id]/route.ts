import { flowStats } from "@/lib/automation/flows-api";
import { json, route, serviceActor } from "@/lib/leads/http";

type Ctx = { params: Promise<{ id: string }> };

/** One flow's results and top keywords. Needs flows:read. */
export const GET = route<Ctx>(async (request, { params }) => {
  const actor = await serviceActor(request, "flows:read");
  return json(await flowStats(actor.workspaceId, (await params).id));
});
