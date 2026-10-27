import Link from "next/link";
import type { MicrosoftConnection } from "@/app/generated/prisma/client";

export default function ConnectionBanner({ connection }: { connection: MicrosoftConnection | null }) {
  if (connection?.status === "ACTIVE") return null;
  const text =
    connection?.status === "NEEDS_REAUTH"
      ? "Your Microsoft 365 connection expired or was revoked. Calendar sync is paused."
      : "Connect your Microsoft 365 calendar to see meetings, book appointments and prepare follow-ups.";
  return (
    <div className="mb-6 rounded border border-warning/40 bg-surface p-4 text-sm">
      {text}{" "}
      <Link href="/meetings/connect" className="font-medium underline">
        {connection ? "Reconnect" : "Connect"}
      </Link>
    </div>
  );
}
