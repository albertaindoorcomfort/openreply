import Link from "next/link";
import type { Meeting } from "@/app/generated/prisma/client";
import { readAttendees } from "@/lib/meetings/events";
import { formatTime } from "@/lib/meetings/time";
import { STATUS_STYLE } from "./data";

export default function MeetingRow({ meeting, timezone, extra }: { meeting: Meeting; timezone: string; extra?: React.ReactNode }) {
  const external = readAttendees(meeting.attendees).filter((a) => !a.internal);
  return (
    <li>
      <Link
        href={`/meetings/${meeting.id}`}
        className="flex items-start gap-4 rounded px-3 py-3 hover:bg-surface-hover focus:bg-surface-hover"
      >
        <span className="w-28 shrink-0 text-sm tabular-nums text-muted">
          {formatTime(meeting.startsAt, timezone)} – {formatTime(meeting.endsAt, timezone)}
        </span>
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-sm font-medium ${STATUS_STYLE[meeting.status]}`}>{meeting.title}</span>
          <span className="block truncate text-xs text-muted">
            {external.length ? external.map((a) => a.name ?? a.email).join(", ") : "Internal"}
            {meeting.isOnline ? " · Teams" : meeting.location ? ` · ${meeting.location}` : ""}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2 text-xs text-muted">
          {meeting.contactId ? <span className="rounded border border-border px-1.5 py-0.5">Lead linked</span> : null}
          {extra}
        </span>
      </Link>
    </li>
  );
}
