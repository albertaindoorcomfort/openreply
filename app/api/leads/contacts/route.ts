import { z } from "zod";
import { listContacts } from "@/lib/leads/records";
import { ingestInbound } from "@/lib/leads/ingest";
import { json, readJson, route, userActor } from "@/lib/leads/http";
import { LeadError } from "@/lib/leads/errors";
import { randomUUID } from "node:crypto";

export const GET = route(async (request) => {
  const actor = await userActor(request);
  const p = request.nextUrl.searchParams;
  return json({
    contacts: await listContacts(actor, {
      q: p.get("q")?.slice(0, 200) || undefined,
      stageKey: p.get("stage")?.slice(0, 50) || undefined,
      includeDeleted: p.get("deleted") === "1",
    }),
  });
});

const Create = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().max(320).optional(),
  phone: z.string().max(40).optional(),
  company: z.string().max(200).optional(),
  note: z.string().max(10_000).optional(),
}).strict();

// A lead entered by hand (walk-in, phone call not yet integrated). Goes through
// the same identity resolution as every channel, so it cannot duplicate a contact.
export const POST = route(async (request) => {
  const actor = await userActor(request);
  const c = Create.parse(await readJson(request));
  const identities = [
    ...(c.email ? [{ kind: "EMAIL" as const, value: c.email }] : []),
    ...(c.phone ? [{ kind: "PHONE" as const, value: c.phone }] : []),
  ];
  if (!identities.length) throw new LeadError("CONTACT_DETAILS_REQUIRED", 400, "Add an email or phone number.");
  const id = `manual:${randomUUID()}`;
  const result = await ingestInbound(actor, {
    channel: "CHAT", channelAccountRef: "manual entry", externalThreadId: id, externalMessageId: id, occurredAt: new Date(),
    from: { displayName: c.name, company: c.company, identities }, body: c.note || "Lead added by hand.", kind: "MESSAGE", attachments: [],
  });
  return json(result, 201);
});
