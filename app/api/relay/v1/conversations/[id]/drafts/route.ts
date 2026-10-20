import { proposeDraft } from "@/lib/leads/drafts";
import { json, readJson, route, serviceActor } from "@/lib/leads/http";

type Ctx = { params: Promise<{ id: string }> };

// An agent proposes a reply. It is stored, never sent.
export const POST = route<Ctx>(async (request, { params }) => {
  const actor = await serviceActor(request, "assist:write");
  const draft = await proposeDraft(actor, (await params).id, (await readJson(request)) as never);
  return json({ draftId: draft.id, status: draft.status, bodySha256: draft.bodySha256, conversationRef: `aic:conversation:${draft.conversationId}` }, 201);
});
