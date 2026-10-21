import Link from "next/link";
import { prisma } from "@/lib/db/client";
import { formatDay } from "@/lib/meetings/time";
import ConnectionBanner from "../_components/connection-banner";
import MeetingRow from "../_components/meeting-row";
import { pageContext } from "../_components/data";

export const metadata = { title: "Meetings" };

export default async function MeetingsPage({ searchParams }: { searchParams: Promise<{ q?: string; when?: string }> }) {
  const { ctx, connection, timezone } = await pageContext();
  const { q = "", when = "upcoming" } = await searchParams;
  const now = new Date();
  const past = when === "past";
  const meetings = await prisma.meeting.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      deletedAt: null,
      ...(past ? { startsAt: { lt: now } } : { endsAt: { gte: now } }),
      ...(q.trim() ? { OR: [{ title: { contains: q.trim(), mode: "insensitive" as const } }, { organizerEmail: { contains: q.trim().toLowerCase() } }] } : {}),
    },
    orderBy: { startsAt: past ? "desc" : "asc" },
    take: 100,
  });

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Meetings</h1>
        <form className="flex gap-2" role="search">
          <input type="hidden" name="when" value={when} />
          <input type="search" name="q" defaultValue={q} placeholder="Search meetings" aria-label="Search meetings" className="rounded border border-border bg-background px-2 py-1.5 text-sm" />
        </form>
      </div>
      <nav className="mb-4 flex gap-4 text-sm" aria-label="Filter">
        <Link href="/meetings" aria-current={!past ? "page" : undefined} className={!past ? "font-medium" : "text-muted"}>
          Upcoming
        </Link>
        <Link href="/meetings?when=past" aria-current={past ? "page" : undefined} className={past ? "font-medium" : "text-muted"}>
          Past
        </Link>
      </nav>
      <ConnectionBanner connection={connection} />
      {meetings.length ? (
        <ul className="divide-y divide-border rounded border border-border">
          {meetings.map((m) => (
            <MeetingRow key={m.id} meeting={m} timezone={timezone} extra={<span>{formatDay(m.startsAt, timezone).split(",").slice(1).join(",").trim()}</span>} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">No meetings found.</p>
      )}
    </div>
  );
}
