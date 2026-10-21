import Link from "next/link";
import { prisma } from "@/lib/db/client";
import { readAttendees } from "@/lib/meetings/events";
import { formatDay, startOfLocalDay } from "@/lib/meetings/time";
import ConnectionBanner from "../_components/connection-banner";
import MeetingRow from "../_components/meeting-row";
import { pageContext } from "../_components/data";

export const metadata = { title: "Today" };

/**
 * The daily view: today's meetings with their prep state, and meetings from
 * the past week that still need a summary or a follow-up.
 */
export default async function TodayPage() {
  const { ctx, connection, timezone } = await pageContext();
  const now = new Date();
  const dayStart = startOfLocalDay(now, timezone);
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);

  const [today, recent, upcoming] = await Promise.all([
    prisma.meeting.findMany({
      where: { workspaceId: ctx.workspaceId, deletedAt: null, startsAt: { gte: dayStart, lt: dayEnd }, status: { not: "CANCELLED" } },
      include: { _count: { select: { briefs: true } } },
      orderBy: { startsAt: "asc" },
    }),
    prisma.meeting.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        deletedAt: null,
        status: "COMPLETED",
        endsAt: { gte: new Date(now.getTime() - 7 * 86_400_000) },
        OR: [{ summaries: { none: {} } }, { followUps: { none: {} } }],
      },
      include: { _count: { select: { summaries: true, notes: true } } },
      orderBy: { endsAt: "desc" },
      take: 20,
    }),
    prisma.meeting.findMany({
      where: { workspaceId: ctx.workspaceId, deletedAt: null, status: "SCHEDULED", startsAt: { gte: dayEnd, lt: new Date(dayEnd.getTime() + 6 * 86_400_000) } },
      orderBy: { startsAt: "asc" },
      take: 15,
    }),
  ]);

  // Internal meetings need a summary but no customer follow-up.
  const needsFollowUp = recent.filter((m) => !m._count.summaries || readAttendees(m.attendees).some((a) => !a.internal));

  return (
    <div>
      <h1 className="text-2xl font-semibold">Today</h1>
      <p className="mb-6 text-sm text-muted">{formatDay(now, timezone)}</p>
      <ConnectionBanner connection={connection} />

      <section aria-labelledby="today-h" className="mb-8">
        <h2 id="today-h" className="mb-2 text-sm font-medium text-muted">
          Meetings today
        </h2>
        {today.length ? (
          <ul className="divide-y divide-border rounded border border-border">
            {today.map((m) => (
              <MeetingRow
                key={m.id}
                meeting={m}
                timezone={timezone}
                extra={m.startsAt > now ? <span>{m._count.briefs ? "Prepped" : "Needs prep"}</span> : null}
              />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">Nothing on the calendar today.</p>
        )}
      </section>

      <section aria-labelledby="follow-h" className="mb-8">
        <h2 id="follow-h" className="mb-2 text-sm font-medium text-muted">
          Waiting on you
        </h2>
        {needsFollowUp.length ? (
          <ul className="divide-y divide-border rounded border border-border">
            {needsFollowUp.map((m) => (
              <MeetingRow
                key={m.id}
                meeting={m}
                timezone={timezone}
                extra={<span>{m._count.summaries ? "Follow-up not prepared" : m._count.notes ? "Summarize notes" : "Add notes"}</span>}
              />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">All recent meetings are summarized and followed up.</p>
        )}
      </section>

      <section aria-labelledby="week-h">
        <h2 id="week-h" className="mb-2 text-sm font-medium text-muted">
          Later this week
        </h2>
        {upcoming.length ? (
          <ul className="divide-y divide-border rounded border border-border">
            {upcoming.map((m) => (
              <MeetingRow key={m.id} meeting={m} timezone={timezone} extra={<span>{formatDay(m.startsAt, timezone).split(",")[0]}</span>} />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">
            Nothing booked. <Link href="/calendar" className="underline">Book a meeting</Link>
          </p>
        )}
      </section>
    </div>
  );
}
