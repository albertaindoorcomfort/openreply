import { discardDraft } from "@/lib/leads/drafts";
import { json, route, userActor } from "@/lib/leads/http";

type Ctx = { params: Promise<{ id: string }> };

export const DELETE = route<Ctx>(async (request, { params }) => {
  const actor = await userActor(request);
  await discardDraft(actor, (await params).id);
  return json({ ok: true });
});
