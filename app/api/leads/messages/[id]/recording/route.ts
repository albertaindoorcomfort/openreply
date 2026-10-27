import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { notFound } from "@/lib/leads/errors";
import { route, userActor } from "@/lib/leads/http";
import { playableUrl, type Attachment } from "@/lib/leads/recordings";

type Ctx = { params: Promise<{ id: string }> };

/** Streams a call recording attached to a message in the signed-in user's workspace. */
export const GET = route<Ctx>(async (request: NextRequest, { params }) => {
  const actor = await userActor(request);
  const message = await prisma.message.findFirst({ where: { id: (await params).id, workspaceId: actor.workspaceId }, select: { attachments: true } });
  if (!message) throw notFound("Recording");
  const index = Number(request.nextUrl.searchParams.get("i") ?? "0");
  const list = Array.isArray(message.attachments) ? (message.attachments as unknown as Attachment[]) : [];
  const att = Number.isInteger(index) && index >= 0 ? list[index] : undefined;
  const url = att && att.contentType?.startsWith("audio/") ? playableUrl(att.url) : null;
  if (!url) throw notFound("Recording");

  const range = request.headers.get("range");
  const upstream = await fetch(url, { headers: range ? { range } : {}, redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!upstream.ok || !upstream.body) throw notFound("Recording");
  const headers = new Headers({ "content-type": att!.contentType!, "cache-control": "private, no-store", "accept-ranges": "bytes" });
  for (const h of ["content-length", "content-range"]) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(upstream.body, { status: upstream.status === 206 ? 206 : 200, headers });
});
