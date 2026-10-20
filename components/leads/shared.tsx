"use client";

/**
 * Shared pieces for the lead inbox pages: a JSON fetch helper that turns API
 * refusals into readable errors, the response types, enum labels and badges.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import type { Locale, StaticMessageKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/provider";

// ---------------------------------------------------------------------------
// API

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

type ErrorBody = { error?: string; message?: string; status?: string };

/** Fetches JSON from the leads API. Throws ApiError on any non-2xx reply. */
export async function api<T>(
  path: string,
  init: { method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"; body?: unknown } = {},
): Promise<T> {
  const method = init.method ?? "GET";
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      cache: "no-store",
      headers: method === "GET" ? undefined : { "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new ApiError("NETWORK_ERROR", "NETWORK_ERROR", 0);
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const body = (data ?? {}) as ErrorBody;
    const code = body.error ?? body.status ?? `HTTP_${res.status}`;
    throw new ApiError(code, body.message || code, res.status);
  }
  return data as T;
}

/** The text to show for a failed call: the server message, else the code. */
export function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message || err.code;
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// Types (only the fields the UI reads)

export type ContactRef = { id: string; displayName: string };

export type Member = { id: string; name: string; role: string };
export type MembersResponse = { me: string; members: Member[] };

export type Task = {
  id: string;
  title: string;
  notes: string | null;
  dueAt: string | null;
  priority: string;
  status: string;
  version: number;
  contact: ContactRef | null;
  conversationId: string | null;
};

export type ConversationListItem = {
  id: string;
  channel: string;
  subject: string | null;
  status: string;
  mode: string;
  ownerUserId: string | null;
  lockUserId: string | null;
  lockExpiresAt: string | null;
  unreadCount: number;
  replyWindowEndsAt: string | null;
  updatedAt: string;
  version: number;
  contact: {
    id: string;
    displayName: string;
    stageKey: string;
    leadScore: number | null;
    primaryEmail: string | null;
    primaryPhone: string | null;
  };
  lastMessage: { id: string; body: string; direction: string; occurredAt: string } | null;
  hasDraft: boolean;
  assessment: { intent: string; urgency: string; summary: string } | null;
};

export type Message = {
  id: string;
  direction: "INBOUND" | "OUTBOUND" | "INTERNAL";
  kind: string;
  authorKind: string;
  authorId: string | null;
  body: string;
  occurredAt: string;
  attachments: unknown;
};

export type Evidence = { kind: string; claim: string; sourceRef?: string | null };

export type Draft = {
  id: string;
  body: string;
  authorKind: string;
  rationale: string | null;
  evidence: Evidence[] | null;
  confidence: number | null;
  status: string;
  errorMessage: string | null;
  createdAt: string;
};

export type NextAction = { action: string; label: string; reason?: string; dueInHours?: number };

export type Assessment = {
  id: string;
  intent: string;
  urgency: string;
  sentiment: string | null;
  leadScore: number | null;
  summary: string;
  nextActions: NextAction[] | null;
  evidence: Evidence[] | null;
  producer: string;
  confidence: number | null;
};

export type ConversationDetail = Omit<ConversationListItem, "contact" | "lastMessage" | "hasDraft" | "assessment"> & {
  contact: ConversationListItem["contact"] & {
    identities?: { id: string; kind: string; value: string }[];
  };
  messages: Message[];
  drafts: Draft[];
  tasks: Task[];
  assessment: Assessment | null;
};

// ---------------------------------------------------------------------------
// Labels

const CHANNEL: Record<string, StaticMessageKey> = {
  WEB_FORM: "Web form",
  EMAIL: "Email",
  INSTAGRAM: "Instagram",
  MESSENGER: "Messenger",
  SMS: "SMS",
  CALL: "Call",
  VOICEMAIL: "Voicemail",
  CHAT: "Chat",
};

const LEVEL: Record<string, StaticMessageKey> = {
  LOW: "Low",
  NORMAL: "Normal",
  HIGH: "High",
  URGENT: "Urgent",
  EMERGENCY: "Emergency",
};

const MODE: Record<string, StaticMessageKey> = {
  HUMAN: "Person replying",
  SUPERVISED: "Carla drafts",
  MANUAL_ONLY: "Manual only",
  AUTONOMOUS: "Carla replies",
};

const INTENT: Record<string, StaticMessageKey> = {
  emergency_service: "Emergency service",
  service_request: "Service request",
  quote_request: "Quote request",
  maintenance: "Maintenance",
  scheduling: "Scheduling",
  billing: "Billing",
  complaint: "Complaint",
  general_question: "General question",
  opt_out: "Opt out",
  spam: "Spam",
};

export const INTENTS = Object.keys(INTENT);
export const URGENCIES = ["LOW", "NORMAL", "HIGH", "EMERGENCY"] as const;
export const PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;

/** Turns a code like "service_area" into "Service area" for unknown values. */
export function humanize(code: string): string {
  const text = code.replace(/[._]+/g, " ").trim().toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function useLeadLabels() {
  const { t } = useI18n();
  const pick = (map: Record<string, StaticMessageKey>, code: string | null | undefined) =>
    code ? (Object.hasOwn(map, code) ? t(map[code]) : humanize(code)) : "";
  return {
    channel: (c: string) => pick(CHANNEL, c),
    level: (c: string) => pick(LEVEL, c),
    mode: (c: string) => pick(MODE, c),
    intent: (c: string) => pick(INTENT, c),
  };
}

// ---------------------------------------------------------------------------
// Formatting

export function formatDateTime(iso: string | null | undefined, locale: Locale): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(locale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function formatShortTime(iso: string | null | undefined, locale: Locale, now: number): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toDateString() === new Date(now).toDateString()
    ? d.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString(locale, { month: "short", day: "numeric" });
}

export function formatMoney(cents: number | null | undefined, currency: string, locale: Locale): string {
  if (cents == null) return "";
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency, maximumFractionDigits: 0 }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(0)} ${currency}`;
  }
}

/** Current time, refreshed every interval, so render code stays pure. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Workspace members for assign pickers. Empty until loaded. */
export function useMembers(): MembersResponse {
  const [data, setData] = useState<MembersResponse>({ me: "", members: [] });
  useEffect(() => {
    api<MembersResponse>("/api/leads/members").then(setData).catch(() => undefined);
  }, []);
  return data;
}

// ---------------------------------------------------------------------------
// Badges and small UI

const URGENCY_CLASS: Record<string, string> = {
  LOW: "border-border text-muted",
  NORMAL: "border-border text-foreground",
  HIGH: "border-warning/40 text-warning",
  URGENT: "border-error/40 text-error",
  EMERGENCY: "border-error bg-error text-white",
};

export function Badge({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={`inline-flex shrink-0 items-center whitespace-nowrap rounded border px-1.5 py-0.5 text-[11px] leading-none ${className || "border-border text-muted"}`}>
      {children}
    </span>
  );
}

export function ChannelBadge({ channel }: { channel: string }) {
  const labels = useLeadLabels();
  return <Badge>{labels.channel(channel)}</Badge>;
}

/** Urgency (assessment) or priority (task) on the same LOW..EMERGENCY scale. */
export function LevelBadge({ level }: { level: string | null | undefined }) {
  const labels = useLeadLabels();
  if (!level) return null;
  return <Badge className={URGENCY_CLASS[level] ?? ""}>{labels.level(level)}</Badge>;
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="text-sm text-error">
      {error}
    </p>
  );
}

const SUBNAV: { href: string; label: StaticMessageKey }[] = [
  { href: "/leads", label: "Inbox" },
  { href: "/leads/pipeline", label: "Pipeline" },
  { href: "/leads/tasks", label: "Tasks" },
  { href: "/leads/knowledge", label: "Business facts" },
];

/** Page title plus links between the lead pages. */
export function LeadsHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  const { t } = useI18n();
  const pathname = usePathname();
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-lg font-semibold text-foreground">{title}</h1>
        <nav aria-label={t("Leads")} className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {SUBNAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={pathname === item.href ? "page" : undefined}
              className={pathname === item.href ? "font-medium text-foreground" : "text-muted hover:text-foreground"}
            >
              {t(item.label)}
            </Link>
          ))}
        </nav>
      </div>
      {children}
    </div>
  );
}

export const inputClass =
  "rounded border border-border bg-background px-2.5 py-1.5 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none";
export const buttonClass =
  "rounded border border-border px-3 py-1.5 text-sm text-foreground hover:bg-surface-hover disabled:opacity-50";
export const primaryButtonClass =
  "rounded bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50";
