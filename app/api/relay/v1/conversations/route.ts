import { z } from "zod";
import { listConversations } from "@/lib/leads/conversations";
import { json, route, serviceActor } from "@/lib/leads/http";

const Query = z.object({
  status: z.enum(["OPEN", "SNOOZED", "CLOSED"]).optional(),
  mode: z.enum(["MANUAL_ONLY", "SUPERVISED", "HUMAN", "AUTONOMOUS"]).optional(),
  contactId: z.string().max(100).optional(),
  q: z.string().max(200).optional(),
});

export const GET = route(async (request) => {
  const actor = await serviceActor(request, "inbox:read");
  const f = Query.parse(Object.fromEntries(request.nextUrl.searchParams));
  return json({ conversations: await listConversations(actor, f) });
});
