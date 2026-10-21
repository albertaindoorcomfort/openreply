import { getMissingMicrosoftEnv, hasScope } from "@/lib/microsoft/config";
import { pageContext } from "../../_components/data";
import DisconnectButton from "./disconnect-button";

export const metadata = { title: "Microsoft 365" };

const MESSAGES: Record<string, string> = {
  connected: "Connected. Your calendar is syncing.",
  denied: "Microsoft sign-in was cancelled or consent was refused.",
  invalid_state: "That sign-in link expired or came from another session. Try again.",
  no_offline_access: "Microsoft did not grant offline access, so the calendar cannot stay in sync. Try again and accept all permissions.",
  mailbox_in_use: "That mailbox is already connected by someone else in this workspace.",
  wrong_tenant: "Only AIC's Microsoft 365 accounts can be connected.",
  error: "Microsoft sign-in failed. Try again.",
};

export default async function ConnectPage({ searchParams }: { searchParams: Promise<{ microsoft?: string }> }) {
  const { connection } = await pageContext();
  const status = (await searchParams).microsoft;
  const missing = getMissingMicrosoftEnv();
  const transcripts = connection ? hasScope(connection.grantedScopes, "OnlineMeetingTranscript.Read.All") : false;

  return (
    <div className="max-w-xl">
      <h1 className="mb-4 text-2xl font-semibold">Microsoft 365</h1>
      {status && MESSAGES[status] ? (
        <p role="status" className={`mb-4 rounded border p-3 text-sm ${status === "connected" ? "border-success/40" : "border-error/40"}`}>
          {MESSAGES[status]}
        </p>
      ) : null}
      {missing.length ? (
        <p className="mb-4 rounded border border-warning/40 p-3 text-sm">
          Not configured on this server. Missing: <code>{missing.join(", ")}</code>.
        </p>
      ) : null}

      {connection && connection.status !== "DISCONNECTED" ? (
        <div className="space-y-3 rounded border border-border p-4 text-sm">
          <p>
            <span className="font-medium">{connection.email}</span>{" "}
            <span className="text-muted">({connection.status === "ACTIVE" ? "syncing" : "needs reconnecting"})</span>
          </p>
          <p className="text-muted">
            Last calendar sync: {connection.calendarSyncedAt ? connection.calendarSyncedAt.toISOString().replace("T", " ").slice(0, 16) + " UTC" : "not yet"}
          </p>
          <p className="text-muted">
            Teams transcripts: {transcripts ? "enabled (organizer's meetings, with consent)" : "off. Typed notes work without it."}
          </p>
          <div className="flex flex-wrap gap-2">
            <a href="/api/microsoft/connect" className="rounded border border-border px-3 py-1.5 hover:bg-surface-hover">
              Reconnect
            </a>
            {!transcripts && (
              <a href="/api/microsoft/connect?transcripts=1" className="rounded border border-border px-3 py-1.5 hover:bg-surface-hover">
                Enable transcripts (needs admin approval)
              </a>
            )}
            <DisconnectButton />
          </div>
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          <p>
            Connecting lets Carla read your Outlook calendar and free/busy, book and move meetings you approve, find Teams meeting details, and save follow-up drafts
            to your Drafts folder. Nothing is sent to a customer without your approval.
          </p>
          <a href="/api/microsoft/connect" className="inline-block rounded bg-foreground px-3 py-1.5 text-background hover:opacity-90">
            Connect Microsoft 365
          </a>
        </div>
      )}
    </div>
  );
}
