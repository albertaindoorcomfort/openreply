import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { json, readJson, route, userActor } from "@/lib/leads/http";

export const GET = route(async (request) => {
  const actor = await userActor(request);
  return json({ entries: await prisma.knowledgeEntry.findMany({ where: { workspaceId: actor.workspaceId }, orderBy: { key: "asc" } }) });
});

const Entry = z.object({
  key: z.string().regex(/^[a-z0-9_]{1,40}$/),
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(4000),
  active: z.boolean().default(true),
}).strict();

// Approved business facts Carla may use. Only admins approve them.
export const PUT = route(async (request) => {
  const actor = await userActor(request, "ADMIN");
  const e = Entry.parse(await readJson(request));
  const row = await prisma.knowledgeEntry.upsert({
    where: { workspaceId_key: { workspaceId: actor.workspaceId, key: e.key } },
    create: { ...e, workspaceId: actor.workspaceId, approvedByUserId: actor.id },
    update: { title: e.title, body: e.body, active: e.active, approvedByUserId: actor.id, version: { increment: 1 } },
  });
  return json(row);
});
