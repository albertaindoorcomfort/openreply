import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { envelope, MEETING_TOOLS, runMeetingTool, ToolError, verifyAicSignature, workspaceForTenant, type MeetingToolName } from "@/lib/meetings/tools";

/**
 * Apollo calls module tools here after its own gate has passed
 * (contracts.md section 3). Other modules in this app add their tools by
 * dispatching on their prefix below.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ tool: string }> }) {
  const { tool } = await params;
  const raw = await request.text();

  if (!(tool in MEETING_TOOLS)) return NextResponse.json({ error: "UNKNOWN_TOOL" }, { status: 404 });
  const secret = process.env.AIC_MODULE_SECRET_MEETINGS;
  if (!secret) return NextResponse.json({ error: "NOT_CONFIGURED" }, { status: 503 });
  if (!verifyAicSignature(raw, request.headers.get("x-aic-timestamp"), request.headers.get("x-aic-signature"), secret)) {
    return NextResponse.json({ error: "BAD_SIGNATURE" }, { status: 401 });
  }

  let body;
  try {
    body = envelope.parse(JSON.parse(raw));
  } catch {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  const workspaceId = workspaceForTenant(body.tenantId);
  if (!workspaceId) return NextResponse.json({ error: "UNKNOWN_TENANT" }, { status: 403 });

  try {
    const result = await runMeetingTool(tool as MeetingToolName, workspaceId, body, request.headers.get("idempotency-key") ?? randomUUID());
    return NextResponse.json({ result });
  } catch (error) {
    if (error instanceof ToolError) return NextResponse.json({ error: error.code, details: error.details }, { status: error.status });
    console.error("[aic-tools] meetings tool failed", tool, error instanceof Error ? error.name : "error");
    return NextResponse.json({ error: "TOOL_FAILED" }, { status: 502 });
  }
}
