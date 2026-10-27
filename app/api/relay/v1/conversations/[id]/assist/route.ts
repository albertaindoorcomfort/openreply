import { runCarla } from "@/lib/leads/carla";
import { json, route, serviceActor } from "@/lib/leads/http";

type Ctx = { params: Promise<{ id: string }> };

// Run AIC OS's classify, summarise and draft loop now, instead of waiting for the queue.
export const POST = route<Ctx>(async (request, { params }) => {
  const actor = await serviceActor(request, "assist:write");
  return json(await runCarla(actor.workspaceId, (await params).id));
});
