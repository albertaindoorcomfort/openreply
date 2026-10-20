import { z } from "zod";
import { requestHandoff } from "@/lib/leads/conversations";
import { json, readJson, route, serviceActor } from "@/lib/leads/http";

type Ctx = { params: Promise<{ id: string }> };
const Body = z.object({ reason: z.string().min(1).max(2000), priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).optional() }).strict();

export const POST = route<Ctx>(async (request, { params }) => {
  const actor = await serviceActor(request, "assist:write");
  const task = await requestHandoff(actor, (await params).id, Body.parse(await readJson(request)));
  return json({ mode: "HUMAN", taskId: task.id }, 201);
});
