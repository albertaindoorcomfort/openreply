import { z } from "zod";
import { listFeedback, recordFeedback } from "@/lib/leads/feedback";
import { json, readJson, route, userActor } from "@/lib/leads/http";

export const POST = route(async (request) => {
  const actor = await userActor(request);
  return json(await recordFeedback(actor, (await readJson(request)) as never), 201);
});

export const GET = route(async (request) => {
  const actor = await userActor(request, "ADMIN");
  const status = z.enum(["NEW", "TRIAGED", "IN_EVAL", "ADOPTED", "REJECTED"]).optional().parse(request.nextUrl.searchParams.get("status") ?? undefined);
  return json({ feedback: await listFeedback(actor, status) });
});
