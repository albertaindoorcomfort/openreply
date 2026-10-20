import { listChanges } from "@/lib/leads/records";
import { json, route, serviceActor } from "@/lib/leads/http";
import { LeadError } from "@/lib/leads/errors";

export const GET = route(async (request) => {
  const actor = await serviceActor(request, "inbox:read");
  const after = request.nextUrl.searchParams.get("after") ?? "0";
  if (!/^\d{1,19}$/.test(after)) throw new LeadError("INVALID_CURSOR", 400);
  return json(await listChanges(actor, BigInt(after), Number(request.nextUrl.searchParams.get("limit") ?? 200)));
});
