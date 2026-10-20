import { updateOpportunity } from "@/lib/leads/records";
import { json, readJson, route, userActor } from "@/lib/leads/http";

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = route<Ctx>(async (request, { params }) => {
  const actor = await userActor(request);
  return json(await updateOpportunity(actor, (await params).id, (await readJson(request)) as never));
});
