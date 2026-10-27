import { NextRequest, NextResponse } from "next/server";
import { runMeetingsMaintenance } from "@/lib/meetings/runtime";

/**
 * Renews Graph subscriptions, retries failed notifications, reconciles
 * calendars, pushes timeline events and applies transcript retention.
 * Run it every 15 minutes from the host's scheduler; once a day is the
 * minimum that keeps subscriptions alive.
 */
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET || process.env.NEXTAUTH_SECRET;
  if (request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ success: true, data: await runMeetingsMaintenance() });
}
