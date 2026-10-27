import { getToday } from "@/lib/leads/today";
import { json, route, userActor } from "@/lib/leads/http";

export const GET = route(async (request) => json(await getToday(await userActor(request))));
