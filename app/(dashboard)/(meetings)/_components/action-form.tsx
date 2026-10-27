"use client";

import { useActionState, useMemo, type ReactNode } from "react";
import type { ActionResult } from "../actions";

/**
 * A form bound to a server action, with a pending state and an announced
 * result. requestId stays the same until the action answers, so a double
 * submit or a retry after a network blip is one request; each answer starts
 * a new one.
 */
export default function ActionForm({
  action,
  children,
  submitLabel,
  pendingLabel,
  variant = "primary",
  className = "",
  withRequestId = false,
}: {
  action: (state: ActionResult, form: FormData) => Promise<ActionResult>;
  children?: ReactNode;
  submitLabel: string;
  pendingLabel?: string;
  variant?: "primary" | "secondary" | "danger";
  className?: string;
  withRequestId?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const requestId = useMemo(() => crypto.randomUUID(), [state]);
  const styles = {
    primary: "bg-foreground text-background hover:opacity-90",
    secondary: "border border-border hover:bg-surface-hover",
    danger: "border border-error text-error hover:bg-surface-hover",
  }[variant];

  return (
    <form action={formAction} className={`space-y-2 ${className}`}>
      {withRequestId && <input type="hidden" name="requestId" value={requestId} suppressHydrationWarning />}
      {children}
      <button type="submit" disabled={pending} className={`rounded px-3 py-1.5 text-sm disabled:opacity-60 ${styles}`}>
        {pending ? pendingLabel ?? "Working…" : submitLabel}
      </button>
      <p role="status" aria-live="polite" className={`text-sm ${state?.ok ? "text-success" : "text-error"}`}>
        {state?.message}
      </p>
    </form>
  );
}
