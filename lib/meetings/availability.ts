/**
 * Pure availability logic: conflict detection and slot proposals. Kept free of
 * I/O so the rules that decide whether an appointment may be confirmed are
 * tested directly.
 */

export interface Interval {
  start: Date;
  end: Date;
}

export interface BusyBlock extends Interval {
  who: string;
  status: string;
  source: "outlook" | "aic";
  meetingId?: string;
}

/** Statuses that block a booking. "free" and "workingElsewhere" do not. */
const BLOCKING = new Set(["busy", "tentative", "oof"]);

export const overlaps = (a: Interval, b: Interval) => a.start < b.end && b.start < a.end;

export function conflictsFor(slot: Interval, busy: BusyBlock[], bufferMinutes = 0): BusyBlock[] {
  const padded = {
    start: new Date(slot.start.getTime() - bufferMinutes * 60_000),
    end: new Date(slot.end.getTime() + bufferMinutes * 60_000),
  };
  return busy.filter((b) => BLOCKING.has(b.status.toLowerCase()) && overlaps(padded, b));
}

/** Wall-clock hour and weekday of an instant in an IANA zone. */
function localParts(d: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { hour: Number(get("hour")), minute: Number(get("minute")), weekday: get("weekday") };
}

export interface SlotRules {
  timeZone: string;
  businessHoursStart: number;
  businessHoursEnd: number;
  durationMinutes: number;
  bufferMinutes: number;
  stepMinutes?: number;
  /** No slot earlier than this (lead time). */
  notBefore: Date;
}

export function withinBusinessHours(slot: Interval, rules: Pick<SlotRules, "timeZone" | "businessHoursStart" | "businessHoursEnd">) {
  const s = localParts(slot.start, rules.timeZone);
  const e = localParts(new Date(slot.end.getTime() - 1), rules.timeZone);
  if (s.weekday === "Sat" || s.weekday === "Sun") return false;
  const startH = s.hour + s.minute / 60;
  const endH = e.hour + (e.minute + 1) / 60;
  return startH >= rules.businessHoursStart && endH <= rules.businessHoursEnd && s.weekday === e.weekday;
}

/** First `limit` free slots inside the window, on step boundaries, in business hours. */
export function proposeSlots(window: Interval, busy: BusyBlock[], rules: SlotRules, limit = 5): Interval[] {
  const step = (rules.stepMinutes ?? 30) * 60_000;
  const dur = rules.durationMinutes * 60_000;
  const first = Math.max(window.start.getTime(), rules.notBefore.getTime());
  const out: Interval[] = [];
  for (let t = Math.ceil(first / step) * step; t + dur <= window.end.getTime() && out.length < limit; t += step) {
    const slot = { start: new Date(t), end: new Date(t + dur) };
    if (!withinBusinessHours(slot, rules)) continue;
    if (conflictsFor(slot, busy, rules.bufferMinutes).length) continue;
    out.push(slot);
  }
  return out;
}
