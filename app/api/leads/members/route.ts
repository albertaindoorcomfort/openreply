import { prisma } from "@/lib/db/client";
import { json, route, userActor } from "@/lib/leads/http";

// People a conversation, lead or task can be assigned to.
export const GET = route(async (request) => {
  const actor = await userActor(request);
  const members = await prisma.workspaceMember.findMany({
    where: { workspaceId: actor.workspaceId },
    include: { user: { select: { id: true, name: true, email: true } } },
  });
  return json({ me: actor.id, members: members.map((m) => ({ id: m.user.id, name: m.user.name ?? m.user.email, role: m.role })) });
});
