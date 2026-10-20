import { getContactProfile } from "@/lib/leads/records";
import { json, route, serviceActor } from "@/lib/leads/http";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (request, { params }) => {
  const actor = await serviceActor(request, "inbox:read");
  return json(await getContactProfile(actor, (await params).id));
});
