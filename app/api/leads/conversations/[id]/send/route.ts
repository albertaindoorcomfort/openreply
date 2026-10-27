import { sendAsUser } from "@/lib/leads/drafts";
import { json, readJson, route, userActor } from "@/lib/leads/http";

type Ctx = { params: Promise<{ id: string }> };

// A person sends a reply, or approves (and maybe edits) AIC OS's draft.
export const POST = route<Ctx>(async (request, { params }) => {
  const actor = await userActor(request);
  const result = await sendAsUser(actor, (await params).id, (await readJson(request)) as never);
  const status = result.status === "SENT" ? 200 : result.status === "FAILED" ? 422 : 409;
  return json(result, status);
});
