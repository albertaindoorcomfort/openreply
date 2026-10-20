import { listContacts } from "@/lib/leads/records";
import { json, route, serviceActor } from "@/lib/leads/http";

export const GET = route(async (request) => {
  const actor = await serviceActor(request, "inbox:read");
  const q = request.nextUrl.searchParams.get("q")?.slice(0, 200) || undefined;
  return json({ contacts: await listContacts(actor, { q }) });
});
