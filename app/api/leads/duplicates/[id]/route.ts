import { dismissDuplicate } from "@/lib/leads/records";
import { json, route, userActor } from "@/lib/leads/http";

type Ctx = { params: Promise<{ id: string }> };

// "These are different people." Merging is POST /api/leads/contacts/:id {action:"merge"}.
export const DELETE = route<Ctx>(async (request, { params }) => {
  const actor = await userActor(request);
  await dismissDuplicate(actor, (await params).id);
  return json({ ok: true });
});
