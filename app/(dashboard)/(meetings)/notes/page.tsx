import Link from "next/link";
import { prisma } from "@/lib/db/client";
import { formatDay } from "@/lib/meetings/time";
import { pageContext } from "../_components/data";

export const metadata = { title: "Notes" };

/** Every meeting note and summary in the workspace, newest first, searchable. */
export default async function NotesPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { ctx, timezone } = await pageContext();
  const q = ((await searchParams).q ?? "").trim();
  const contains = q ? { contains: q, mode: "insensitive" as const } : undefined;
  const [notes, summaries] = await Promise.all([
    prisma.meetingNote.findMany({
      where: { workspaceId: ctx.workspaceId, deletedAt: null, ...(contains ? { body: contains } : {}) },
      include: { meeting: { select: { id: true, title: true, startsAt: true } } },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    prisma.meetingSummary.findMany({
      where: { workspaceId: ctx.workspaceId, supersededAt: null, ...(contains ? { summary: contains } : {}) },
      include: { meeting: { select: { id: true, title: true, startsAt: true } } },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  ]);
  const items = [
    ...notes.map((n) => ({ id: n.id, kind: n.kind === "TRANSCRIPT" ? "Transcript" : "Note", text: n.body, at: n.createdAt, meeting: n.meeting })),
    ...summaries.map((s) => ({ id: s.id, kind: "Summary", text: s.summary, at: s.createdAt, meeting: s.meeting })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Notes</h1>
        <form role="search">
          <input type="search" name="q" defaultValue={q} placeholder="Search notes" aria-label="Search notes" className="rounded border border-border bg-background px-2 py-1.5 text-sm" />
        </form>
      </div>
      {items.length ? (
        <ul className="space-y-3">
          {items.map((i) => (
            <li key={i.id} className="rounded border border-border p-3">
              <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2 text-xs text-muted">
                <Link href={`/meetings/${i.meeting.id}`} className="font-medium text-foreground underline-offset-2 hover:underline">
                  {i.meeting.title}
                </Link>
                <span>
                  {i.kind} · {formatDay(i.meeting.startsAt, timezone)}
                </span>
              </div>
              <p className="line-clamp-4 whitespace-pre-wrap text-sm">{i.text}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">{q ? "No notes match." : "No notes yet. Notes you take in a meeting appear here."}</p>
      )}
    </div>
  );
}
