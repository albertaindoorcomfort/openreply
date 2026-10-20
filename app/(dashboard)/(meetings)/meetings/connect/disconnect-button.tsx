"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function DisconnectButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      className="rounded border border-error px-3 py-1.5 text-error hover:bg-surface-hover disabled:opacity-60"
      onClick={async () => {
        if (!window.confirm("Stop syncing this calendar? Meetings and notes already captured stay.")) return;
        setBusy(true);
        await fetch("/api/microsoft/disconnect", { method: "POST" });
        router.refresh();
        setBusy(false);
      }}
    >
      Disconnect
    </button>
  );
}
