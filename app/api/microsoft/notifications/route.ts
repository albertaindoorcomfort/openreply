import { after, NextRequest, NextResponse } from "next/server";
import { getGraphClientForConnection } from "@/lib/microsoft/connection";
import { ingestNotifications, notificationBatch, processPendingNotifications } from "@/lib/microsoft/notifications";
import { relayFromEnv } from "@/lib/meetings/relay-client";

/**
 * Graph change notifications (and, through the lifecycle route, lifecycle
 * events). Graph validates the URL by POSTing ?validationToken=..., which must
 * be echoed as text/plain within 10 seconds. Real notifications are stored and
 * acknowledged with 202; processing happens after the response.
 */
export async function POST(request: NextRequest) {
  const validationToken = request.nextUrl.searchParams.get("validationToken");
  if (validationToken !== null) {
    return new NextResponse(validationToken.slice(0, 1024), {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" },
    });
  }

  const parsed = notificationBatch.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "INVALID" }, { status: 400 });

  const result = await ingestNotifications(parsed.data.value);
  if (result.connectionIds.length) {
    after(async () => {
      for (const connectionId of result.connectionIds) {
        await processPendingNotifications({ graph: getGraphClientForConnection, relay: relayFromEnv() }, { connectionId }).catch(() => undefined);
      }
    });
  }
  return new NextResponse(null, { status: 202 });
}
