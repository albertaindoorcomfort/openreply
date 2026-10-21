import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceContext } from "@/lib/workspace-access";
import { getMissingMicrosoftEnv } from "@/lib/microsoft/config";
import { PKCE_COOKIE, startAuthorization } from "@/lib/microsoft/oauth";

/**
 * Starts the Microsoft 365 connection for the signed-in user.
 * ?transcripts=1 also asks for Teams transcript access (needs admin consent).
 */
export async function GET(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) return NextResponse.redirect(new URL("/login", request.url));

  const missing = getMissingMicrosoftEnv();
  if (missing.length) {
    return NextResponse.json({ success: false, error: "Microsoft 365 is not configured", missing }, { status: 503 });
  }

  const { url, cookieValue } = startAuthorization({
    workspaceId: context.workspaceId,
    userId: context.userId,
    transcripts: request.nextUrl.searchParams.get("transcripts") === "1",
  });
  const response = NextResponse.redirect(url);
  response.cookies.set(PKCE_COOKIE, cookieValue, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/microsoft/callback",
    maxAge: 600,
  });
  return response;
}
