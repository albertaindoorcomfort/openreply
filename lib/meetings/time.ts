/** Offset of an IANA zone at an instant, in minutes east of UTC. */
function offsetMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/** "2026-11-02T09:00" read as wall time in `timeZone`, to an instant. Null if malformed. */
export function zonedToUtc(local: string, timeZone: string): Date | null {
  const m = local.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  // Two passes settle the offset even right after a DST change.
  let t = guess - offsetMinutes(new Date(guess), timeZone) * 60_000;
  t = guess - offsetMinutes(new Date(t), timeZone) * 60_000;
  return new Date(t);
}

/** Instant to the "YYYY-MM-DDTHH:mm" a datetime-local input expects, in `timeZone`. */
export function utcToLocalInput(d: Date, timeZone: string): string {
  const shifted = new Date(d.getTime() + offsetMinutes(d, timeZone) * 60_000);
  return shifted.toISOString().slice(0, 16);
}

export function formatTime(d: Date, timeZone: string) {
  return d.toLocaleTimeString("en-CA", { timeZone, hour: "numeric", minute: "2-digit" });
}

export function formatDay(d: Date, timeZone: string) {
  return d.toLocaleDateString("en-CA", { timeZone, weekday: "long", month: "long", day: "numeric" });
}

/** Start of the local day containing `d`, as an instant. */
export function startOfLocalDay(d: Date, timeZone: string): Date {
  return zonedToUtc(`${utcToLocalInput(d, timeZone).slice(0, 10)}T00:00`, timeZone)!;
}
