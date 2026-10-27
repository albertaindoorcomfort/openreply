import { z } from "zod";
import {
  acquireLock, addInternal, assign, markRead, releaseLock, setMode, setStatus, takeOver,
} from "@/lib/leads/conversations";
import { runCarla } from "@/lib/leads/carla";
import { json, readJson, route, userActor } from "@/lib/leads/http";

type Ctx = { params: Promise<{ id: string }> };

const Action = z.discriminatedUnion("action", [
  z.object({ action: z.literal("takeover") }),
  z.object({ action: z.literal("resume") }),
  z.object({ action: z.literal("manual_only") }),
  z.object({ action: z.literal("close") }),
  z.object({ action: z.literal("reopen") }),
  z.object({ action: z.literal("snooze") }),
  z.object({ action: z.literal("read") }),
  z.object({ action: z.literal("lock") }),
  z.object({ action: z.literal("unlock") }),
  z.object({ action: z.literal("assign"), ownerUserId: z.string().max(100).nullable(), version: z.number().int().optional() }),
  z.object({ action: z.literal("note"), body: z.string().min(1).max(10_000) }),
  /** Private guidance for AIC OS. Never shown to the customer. */
  z.object({ action: z.literal("coach"), body: z.string().min(1).max(10_000) }),
  /** Ask AIC OS to re-read the conversation now (after coaching, for example). */
  z.object({ action: z.literal("assist") }),
]);

export const POST = route<Ctx>(async (request, { params }) => {
  const actor = await userActor(request);
  const id = (await params).id;
  const a = Action.parse(await readJson(request));
  switch (a.action) {
    case "takeover": await takeOver(actor, id); break;
    case "resume": await setMode(actor, id, "SUPERVISED"); break;
    case "manual_only": await setMode(actor, id, "MANUAL_ONLY"); break;
    case "close": await setStatus(actor, id, "CLOSED"); break;
    case "reopen": await setStatus(actor, id, "OPEN"); break;
    case "snooze": await setStatus(actor, id, "SNOOZED"); break;
    case "read": await markRead(actor, id); break;
    case "lock": return json(await acquireLock(actor, id));
    case "unlock": await releaseLock(actor, id); break;
    case "assign": await assign(actor, id, a.ownerUserId, a.version); break;
    case "note": return json(await addInternal(actor, id, "NOTE", a.body), 201);
    case "coach": return json(await addInternal(actor, id, "COACHING", a.body), 201);
    case "assist": return json(await runCarla(actor.workspaceId, id));
  }
  return json({ ok: true });
});
