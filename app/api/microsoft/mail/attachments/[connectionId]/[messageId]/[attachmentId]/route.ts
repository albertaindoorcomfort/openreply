import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getCurrentWorkspaceContext } from "@/lib/workspace-access";
import { ConnectionUnavailableError, getGraphClientForConnection } from "@/lib/microsoft/connection";
import { GraphError } from "@/lib/microsoft/graph";

const MAX_BYTES = 25 * 1024 * 1024;
/** Types a browser may show inline; anything else downloads as bytes. */
const SAFE_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp", "text/plain"]);

type Params = { connectionId: string; messageId: string; attachmentId: string };

/**
 * An attachment of an email that was ingested into the lead inbox. Relay
 * stores this URL as the attachment ref. Only members of the mailbox's
 * workspace can open it, and only for messages on the ingest ledger, so the
 * route cannot be used to read anything else in the mailbox.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<Params> }) {
  const { connectionId, messageId, attachmentId } = await params;
  const context = await getCurrentWorkspaceContext();
  if (!context) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const mail = await prisma.inboundMail.findUnique({
    where: { connectionId_graphMessageId: { connectionId, graphMessageId: messageId } },
    select: { workspaceId: true, status: true },
  });
  if (!mail || mail.workspaceId !== context.workspaceId || mail.status !== "DELIVERED") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const graph = getGraphClientForConnection(connectionId);
    const meta = await graph.getAttachment(messageId, attachmentId);
    if (meta["@odata.type"] && meta["@odata.type"] !== "#microsoft.graph.fileAttachment") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if ((meta.size ?? 0) > MAX_BYTES) return NextResponse.json({ error: "Attachment too large; open it in Outlook" }, { status: 413 });
    const { bytes } = await graph.attachmentContent(messageId, attachmentId);
    const type = (meta.contentType ?? "").split(";")[0].trim().toLowerCase();
    const name = (meta.name || "attachment").replace(/["\\\r\n]/g, "_");
    return new NextResponse(bytes, {
      headers: {
        "content-type": SAFE_TYPES.has(type) ? type : "application/octet-stream",
        "content-disposition": `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox",
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    if (error instanceof GraphError && error.isNotFound) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (error instanceof ConnectionUnavailableError) return NextResponse.json({ error: "Mailbox needs to be reconnected" }, { status: 409 });
    return NextResponse.json({ error: "Could not fetch the attachment" }, { status: 502 });
  }
}
