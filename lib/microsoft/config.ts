import { getBaseUrl } from "@/lib/env";

/**
 * Microsoft 365 app registration settings.
 *
 * The app is a confidential web client registered in Entra ID. Redirect URI:
 * `${NEXTAUTH_URL}/api/microsoft/callback`. MICROSOFT_TENANT is the directory
 * id of AIC's tenant; "organizations" accepts any work account and is only
 * for development.
 */
export const MICROSOFT_ENV = [
  "MICROSOFT_CLIENT_ID",
  "MICROSOFT_CLIENT_SECRET",
  "MICROSOFT_TENANT",
  "ENCRYPTION_KEY",
  "NEXTAUTH_SECRET",
] as const;

export function getMissingMicrosoftEnv(): string[] {
  return MICROSOFT_ENV.filter((name) => !process.env[name]);
}

export function microsoftTenant(): string {
  return process.env.MICROSOFT_TENANT ?? "organizations";
}

export function microsoftRedirectUri(): string {
  return `${getBaseUrl()}/api/microsoft/callback`;
}

/**
 * Graph must reach these over public HTTPS. MICROSOFT_WEBHOOK_BASE_URL lets a
 * deployment behind a tunnel or a different public host override NEXTAUTH_URL.
 */
export function graphNotificationUrls() {
  const base = process.env.MICROSOFT_WEBHOOK_BASE_URL ?? getBaseUrl();
  return {
    notificationUrl: `${base}/api/microsoft/notifications`,
    lifecycleNotificationUrl: `${base}/api/microsoft/lifecycle`,
  };
}

/**
 * Delegated scopes asked for on connect. All are user-consentable in a
 * default tenant. Mail.Send is here so Relay can send approved email from the
 * user's mailbox; meetings itself never sends mail.
 */
export const BASE_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "User.Read",
  "Calendars.ReadWrite",
  "Mail.ReadWrite",
  "Mail.Send",
  "Contacts.Read",
  "OnlineMeetings.Read",
] as const;

/**
 * Teams transcript access. Needs tenant admin consent, so it is a separate,
 * optional step: without it, meetings fall back to typed notes.
 */
export const TRANSCRIPT_SCOPES = ["OnlineMeetingTranscript.Read.All"] as const;

export function hasScope(granted: string[], scope: string): boolean {
  const wanted = scope.toLowerCase();
  return granted.some((s) => {
    const name = s.toLowerCase().replace(/^https:\/\/graph\.microsoft\.com\//, "");
    return name === wanted;
  });
}
