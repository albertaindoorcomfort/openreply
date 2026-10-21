import { ingestInbound, InboundEventSchema } from "@/lib/leads/ingest";
import { enqueueCarla } from "@/lib/leads/queue";
import { json, readJson, route, serviceActor } from "@/lib/leads/http";

// A channel adapter (Outlook, RingCentral, chat) posts one normalised inbound message.
export const POST = route(async (request) => {
  const actor = await serviceActor(request, "events:ingest");
  const event = InboundEventSchema.parse(await readJson(request));
  const result = await ingestInbound(actor, event);
  if (!result.duplicate) {
    await enqueueCarla({ workspaceId: actor.workspaceId, conversationId: result.conversationId, messageId: result.messageId });
  }
  return json(result, result.duplicate ? 200 : 201);
});
