import { z } from "zod";
import { listConversations } from "@/lib/leads/conversations";
import { json, route, userActor } from "@/lib/leads/http";

const Query = z.object({
  status: z.enum(["OPEN", "SNOOZED", "CLOSED"]).optional(),
  mode: z.enum(["MANUAL_ONLY", "SUPERVISED", "HUMAN", "AUTONOMOUS"]).optional(),
  mine: z.enum(["1"]).optional(),
  contactId: z.string().max(100).optional(),
  q: z.string().max(200).optional(),
});

export const GET = route(async (request) => {
  const actor = await userActor(request);
  const { mine, ...f } = Query.parse(Object.fromEntries(request.nextUrl.searchParams));
  return json({ conversations: await listConversations(actor, { ...f, ownerUserId: mine ? actor.id : undefined }) });
});
