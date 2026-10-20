import Link from "next/link";
import { prisma } from "@/lib/db/client";
import { formatDay, startOfLocalDay, utcToLocalInput } from "@/lib/meetings/time";
import { bookAction } from "../actions";
import ActionForm from "../_components/action-form";
import ConnectionBanner from "../_components/connection-banner";
import MeetingRow from "../_components/meeting-row";
import { pageContext } from "../_components/data";

export const metadata = { title: "Calendar" };

/** Default for the booking form: this time tomorrow, rounded up to the half hour. */
function tomorrowOnTheHalfHour(timezone: string) {
  return utcToLocalInput(new Date(Math.ceil((Date.now() + 86_400_000) / 1_800_000) * 1_800_000), timezone);
}

const field = "w-full rounded border border-border bg-background px-2 py-1.5 text-sm";

export default async function CalendarPage({ searchParams }: { searchParams: Promise<{ week?: string; contact?: string }> }) {
  const { ctx, connection, timezone } = await pageContext();
  const params = await searchParams;
  const week = Math.max(-52, Math.min(52, Number(params.week ?? 0) || 0));
  const start = new Date(startOfLocalDay(new Date(), timezone).getTime() + week * 7 * 86_400_000);
  const end = new Date(start.getTime() + 7 * 86_400_000);

  const meetings = await prisma.meeting.findMany({
    where: { workspaceId: ctx.workspaceId, deletedAt: null, startsAt: { gte: start, lt: end } },
    orderBy: { startsAt: "asc" },
  });
  const days = new Map<string, typeof meetings>();
  for (const m of meetings) {
    const key = formatDay(m.startsAt, timezone);
    days.set(key, [...(days.get(key) ?? []), m]);
  }
  const defaultStart = tomorrowOnTheHalfHour(timezone);

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_20rem]">
      <div>
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Calendar</h1>
          <nav className="flex gap-2 text-sm" aria-label="Week">
            <Link className="rounded border border-border px-2 py-1 hover:bg-surface-hover" href={`/calendar?week=${week - 1}`}>
              ← Previous
            </Link>
            <Link className="rounded border border-border px-2 py-1 hover:bg-surface-hover" href="/calendar">
              This week
            </Link>
            <Link className="rounded border border-border px-2 py-1 hover:bg-surface-hover" href={`/calendar?week=${week + 1}`}>
              Next →
            </Link>
          </nav>
        </div>
        <ConnectionBanner connection={connection} />
        {days.size ? (
          [...days.entries()].map(([day, list]) => (
            <section key={day} className="mb-6">
              <h2 className="mb-1 text-sm font-medium text-muted">{day}</h2>
              <ul className="divide-y divide-border rounded border border-border">
                {list.map((m) => (
                  <MeetingRow key={m.id} meeting={m} timezone={timezone} />
                ))}
              </ul>
            </section>
          ))
        ) : (
          <p className="text-sm text-muted">No meetings this week.</p>
        )}
      </div>

      <aside aria-labelledby="book-h" className="h-fit rounded border border-border p-4">
        <h2 id="book-h" className="mb-1 font-medium">
          Book a meeting
        </h2>
        <p className="mb-3 text-xs text-muted">
          Checks Outlook free/busy for you and any AIC attendees first. Invites go out from your mailbox.
        </p>
        {connection?.status === "ACTIVE" ? (
          <ActionForm action={bookAction} submitLabel="Check and book" pendingLabel="Checking calendars…" withRequestId>
            <label className="block text-sm">
              Title
              <input name="title" required maxLength={200} className={field} />
            </label>
            <label className="block text-sm">
              Starts ({timezone})
              <input name="start" type="datetime-local" required defaultValue={defaultStart} className={field} />
            </label>
            <label className="block text-sm">
              Length
              <select name="duration" defaultValue="60" className={field}>
                {[15, 30, 45, 60, 90, 120].map((d) => (
                  <option key={d} value={d}>
                    {d} minutes
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              Attendees
              <textarea name="attendees" rows={2} placeholder="name@example.com, tech@aic…" className={field} />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input name="teams" type="checkbox" defaultChecked /> Teams meeting
            </label>
            <label className="block text-sm">
              Location
              <input name="location" maxLength={200} className={field} />
            </label>
            <label className="block text-sm">
              Agenda
              <textarea name="agenda" rows={3} maxLength={4000} className={field} />
            </label>
            <label className="block text-sm">
              Lead (contact id)
              <input name="contactId" defaultValue={params.contact ?? ""} maxLength={100} className={field} />
            </label>
          </ActionForm>
        ) : (
          <p className="text-sm text-muted">Connect Microsoft 365 to book.</p>
        )}
      </aside>
    </div>
  );
}
