import { writeExternalEvent } from "@/lib/leads/records";
import { json, readJson, route, serviceActor } from "@/lib/leads/http";

// Meetings and calls write meeting.*, call.* and voicemail.* events. Idempotent on idempotencyKey.
export const POST = route(async (request) => {
  const actor = await serviceActor(request, "timeline:write");
  const result = await writeExternalEvent(actor, (await readJson(request)) as never);
  return json(result, result.duplicate ? 200 : 201);
});
