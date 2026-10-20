import { z } from "zod";
import { createTask, listTasks } from "@/lib/leads/records";
import { json, readJson, route, userActor } from "@/lib/leads/http";

const Query = z.object({
  status: z.enum(["OPEN", "DONE", "CANCELLED"]).optional(),
  mine: z.enum(["1"]).optional(),
  contactId: z.string().max(100).optional(),
});

export const GET = route(async (request) => {
  const actor = await userActor(request);
  const q = Query.parse(Object.fromEntries(request.nextUrl.searchParams));
  return json({ tasks: await listTasks(actor, { status: q.status, contactId: q.contactId, assigneeUserId: q.mine ? actor.id : undefined }) });
});

export const POST = route(async (request) => {
  const actor = await userActor(request);
  return json(await createTask(actor, (await readJson(request)) as never), 201);
});
