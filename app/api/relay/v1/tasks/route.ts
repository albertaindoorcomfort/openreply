import { createTask } from "@/lib/leads/records";
import { json, readJson, route, serviceActor } from "@/lib/leads/http";

export const POST = route(async (request) => {
  const actor = await serviceActor(request, "tasks:write");
  return json(await createTask(actor, (await readJson(request)) as never), 201);
});
