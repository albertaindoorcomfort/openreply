import { getBoard } from "@/lib/leads/records";
import { json, route, userActor } from "@/lib/leads/http";

export const GET = route(async (request) => json(await getBoard(await userActor(request))));
