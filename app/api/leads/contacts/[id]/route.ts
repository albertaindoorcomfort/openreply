import { z } from "zod";
import { getContactProfile, mergeContacts, setContactDeleted, updateContact } from "@/lib/leads/records";
import { recordConsentTx } from "@/lib/leads/consent";
import { prisma } from "@/lib/db/client";
import { json, readJson, route, userActor } from "@/lib/leads/http";
import { notFound } from "@/lib/leads/errors";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (request, { params }) => {
  const actor = await userActor(request);
  return json(await getContactProfile(actor, (await params).id));
});

export const PATCH = route<Ctx>(async (request, { params }) => {
  const actor = await userActor(request);
  return json(await updateContact(actor, (await params).id, (await readJson(request)) as never));
});

// Soft delete. Restore with POST {action:"restore"}.
export const DELETE = route<Ctx>(async (request, { params }) => {
  const actor = await userActor(request, "ADMIN");
  await setContactDeleted(actor, (await params).id, true);
  return json({ ok: true });
});

const Action = z.discriminatedUnion("action", [
  z.object({ action: z.literal("restore") }),
  /** Merge the other contact into this one. */
  z.object({ action: z.literal("merge"), otherContactId: z.string().max(100) }),
  z.object({
    action: z.literal("consent"),
    channel: z.enum(["EMAIL", "SMS", "CALL", "DM"]),
    status: z.enum(["GRANTED", "WITHDRAWN"]),
    basis: z.enum(["EXPRESS", "IMPLIED"]).default("EXPRESS"),
    evidence: z.string().max(2000).optional(),
  }),
]);

export const POST = route<Ctx>(async (request, { params }) => {
  const id = (await params).id;
  const a = Action.parse(await readJson(request));
  if (a.action === "restore") {
    await setContactDeleted(await userActor(request, "ADMIN"), id, false);
  } else if (a.action === "merge") {
    await mergeContacts(await userActor(request, "ADMIN"), id, a.otherContactId);
  } else {
    const actor = await userActor(request);
    await prisma.$transaction(async (tx) => {
      const c = await tx.contact.findFirst({ where: { id, workspaceId: actor.workspaceId } });
      if (!c) throw notFound("Contact");
      await recordConsentTx(tx, actor, id, { channel: a.channel, status: a.status, basis: a.basis, source: `recorded by staff`, evidence: a.evidence });
    });
  }
  return json({ ok: true });
});
