import type { MicrosoftConnection } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { decryptToken, encryptToken } from "@/lib/meta/oauth";
import { GraphClient, type Fetch, type TokenProvider } from "./graph";
import { MicrosoftTokenError, refreshAccessToken, scopesOf, type TokenResponse } from "./oauth";

/** Refresh a little early so a token never expires mid-request. */
const REFRESH_MARGIN_MS = 2 * 60 * 1000;

export class ConnectionUnavailableError extends Error {
  constructor(readonly connectionId: string, readonly reason: string) {
    super(`microsoft connection ${connectionId} unavailable: ${reason}`);
  }
}

/**
 * Access tokens for one connection, refreshed and re-encrypted on use. A dead
 * refresh token flips the connection to NEEDS_REAUTH so the UI asks the user
 * to connect again and background jobs stop calling Graph for it.
 */
export function connectionTokenProvider(connectionId: string, f: Fetch = fetch): TokenProvider {
  return {
    async get() {
      const c = await prisma.microsoftConnection.findUnique({ where: { id: connectionId } });
      if (!c || c.status !== "ACTIVE") throw new ConnectionUnavailableError(connectionId, c?.status ?? "missing");
      if (c.accessExpiresAt.getTime() - REFRESH_MARGIN_MS > Date.now()) return decryptToken(c.accessTokenEnc);

      let token: TokenResponse;
      try {
        token = await refreshAccessToken(decryptToken(c.refreshTokenEnc), c.grantedScopes, f);
      } catch (error) {
        if (error instanceof MicrosoftTokenError && error.needsReauth) {
          await markNeedsReauth(c.id, error.code);
          throw new ConnectionUnavailableError(connectionId, "NEEDS_REAUTH");
        }
        throw error;
      }
      await prisma.microsoftConnection.update({
        where: { id: c.id },
        data: tokenFields(token, c.refreshTokenEnc),
      });
      return token.access_token;
    },
  };
}

export function tokenFields(token: TokenResponse, previousRefreshEnc?: string) {
  const granted = scopesOf(token);
  return {
    accessTokenEnc: encryptToken(token.access_token),
    accessExpiresAt: new Date(Date.now() + token.expires_in * 1000),
    // Microsoft rotates refresh tokens; keep the old one only if no new one came back.
    refreshTokenEnc: token.refresh_token ? encryptToken(token.refresh_token) : previousRefreshEnc!,
    ...(granted.length ? { grantedScopes: granted } : {}),
  };
}

export async function markNeedsReauth(connectionId: string, reason: string) {
  await prisma.microsoftConnection.update({
    where: { id: connectionId },
    data: { status: "NEEDS_REAUTH", statusReason: reason },
  });
}

export function getGraphClientForConnection(connectionId: string, f: Fetch = fetch): GraphClient {
  return new GraphClient(connectionTokenProvider(connectionId, f), f);
}

/** The signed-in user's own connection in this workspace, if any. */
export function findUserConnection(workspaceId: string, userId: string): Promise<MicrosoftConnection | null> {
  return prisma.microsoftConnection.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });
}

export function findConnectionByEmail(workspaceId: string, email: string) {
  return prisma.microsoftConnection.findFirst({
    where: { workspaceId, email: email.toLowerCase(), status: "ACTIVE" },
  });
}
