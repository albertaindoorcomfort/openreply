import { getConversation } from "@/lib/leads/conversations";
import { json, route, userActor } from "@/lib/leads/http";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (request, { params }) => {
  const actor = await userActor(request);
  return json(await getConversation(actor, (await params).id));
});
