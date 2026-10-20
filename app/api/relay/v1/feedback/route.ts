import { z } from "zod";
import { recordFeedback } from "@/lib/leads/feedback";
import { IdempotencyKeySchema } from "@/lib/leads/drafts";
import { json, readJson, route, serviceActor } from "@/lib/leads/http";

const EnvelopeSchema = z.object({
  correctedBy: z.string().min(1).max(100),
  contactId: z.string().max(100).optional(),
});

// A module forwards a person's correction (a meeting note, a summary, a draft).
export const POST = route(async (request) => {
  const actor = await serviceActor(request, "feedback:write");
  const { correctedBy, contactId, ...feedback } = (await readJson(request)) as Record<string, unknown>;
  const envelope = EnvelopeSchema.parse({ correctedBy, contactId });
  const header = request.headers.get("idempotency-key");
  const idempotencyKey = header === null ? undefined : IdempotencyKeySchema.parse(header);
  const fb = await recordFeedback(actor, feedback as never, { ...envelope, idempotencyKey });
  return json({ feedbackId: fb.id, status: fb.status }, 201);
});
