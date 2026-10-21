"use client";

/**
 * Leads inbox
 *
 * Every lead conversation (web forms, email, Instagram, SMS, calls) in one
 * place. Three panes: the conversation list, the open thread with Carla's
 * draft and the composer, and the Copilot panel with Carla's assessment.
 * The open conversation lives in the URL (?c=<id>) so links from Today and
 * the contact profile land on it. List and thread poll every 10 seconds.
 */

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/provider";
import {
  api,
  ApiError,
  Badge,
  ChannelBadge,
  ErrorNote,
  errorText,
  formatShortTime,
  inputClass,
  LeadsHeader,
  LevelBadge,
  useMembers,
  useNow,
  type ConversationDetail,
  type ConversationListItem,
  usePolling,
} from "@/components/leads/shared";
import Thread from "@/components/leads/thread";
import Copilot from "@/components/leads/copilot";

const POLL_MS = 10_000;

type Filter = "open" | "mine" | "human" | "closed";

function filterQuery(filter: Filter, q: string): string {
  const params = new URLSearchParams();
  params.set("status", filter === "closed" ? "CLOSED" : "OPEN");
  if (filter === "mine") params.set("mine", "1");
  if (filter === "human") params.set("mode", "HUMAN");
  if (q) params.set("q", q);
  return params.toString();
}

export default function LeadsPage() {
  return (
    <Suspense fallback={null}>
      <LeadsInbox />
    </Suspense>
  );
}

function LeadsInbox() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activeId = searchParams.get("c");
  const now = useNow(15_000);
  const { me, members } = useMembers();

  const [filter, setFilter] = useState<Filter>("open");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [conversations, setConversations] = useState<ConversationListItem[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [copilotOpen, setCopilotOpen] = useState(
    () => typeof window === "undefined" || window.matchMedia("(min-width: 1024px)").matches,
  );
  const listRef = useRef<HTMLDivElement>(null);

  // Debounce the search box.
  useEffect(() => {
    const timer = window.setTimeout(() => setQ(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const loadList = useCallback(async () => {
    try {
      const res = await api<{ conversations: ConversationListItem[] }>(
        `/api/leads/conversations?${filterQuery(filter, q)}`,
      );
      setConversations(res.conversations);
      setListError(null);
    } catch (err) {
      setListError(errorText(err));
    }
  }, [filter, q]);

  usePolling(loadList, POLL_MS);

  const loadDetail = useCallback(async () => {
    if (!activeId) return;
    try {
      const res = await api<ConversationDetail>(`/api/leads/conversations/${activeId}`);
      setDetail(res);
      setDetailError(null);
    } catch (err) {
      setDetailError(errorText(err));
      if (err instanceof ApiError && err.status === 404) setDetail(null);
    }
  }, [activeId]);

  // Load and poll the open thread.
  usePolling(loadDetail, activeId ? POLL_MS : null);

  // Mark a thread read when it is opened, then refresh the unread dots.
  const loadListRef = useRef(loadList);
  useEffect(() => {
    loadListRef.current = loadList;
  }, [loadList]);
  useEffect(() => {
    if (!activeId) return;
    api(`/api/leads/conversations/${activeId}/actions`, { method: "POST", body: { action: "read" } })
      .then(() => loadListRef.current())
      .catch(() => undefined);
  }, [activeId]);

  const reloadAll = useCallback(async () => {
    await Promise.all([loadDetail(), loadList()]);
  }, [loadDetail, loadList]);

  function open(id: string | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (id) params.set("c", id);
    else params.delete("c");
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  // Arrow keys move through the list.
  function handleListKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!conversations?.length || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
    e.preventDefault();
    const index = conversations.findIndex((c) => c.id === activeId);
    const next =
      e.key === "ArrowDown"
        ? Math.min(conversations.length - 1, index + 1)
        : Math.max(0, index === -1 ? 0 : index - 1);
    const id = conversations[next].id;
    open(id);
    listRef.current?.querySelector<HTMLButtonElement>(`[data-id="${id}"]`)?.focus();
  }

  const shown = detail && detail.id === activeId ? detail : null;
  const tabs: [Filter, string][] = [
    ["open", t("Open")],
    ["mine", t("Mine")],
    ["human", t("Needs a person")],
    ["closed", t("Closed")],
  ];

  return (
    <div className="space-y-4">
      <LeadsHeader title={t("Leads")} />

      <div
        className={`relative grid h-[calc(100dvh-12rem)] min-h-[420px] grid-cols-1 overflow-hidden rounded border border-border sm:grid-cols-[280px_1fr] ${
          copilotOpen && shown ? "lg:grid-cols-[280px_1fr_300px]" : ""
        }`}
      >
        {/* List */}
        <div className={`min-h-0 flex-col border-border sm:flex sm:border-r ${activeId ? "hidden" : "flex"}`}>
          <div className="shrink-0 space-y-2 border-b border-border p-3">
            <div role="tablist" aria-label={t("Filter conversations")} className="flex flex-wrap gap-1 text-xs">
              {tabs.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={filter === value}
                  onClick={() => setFilter(value)}
                  className={`rounded px-2 py-1 ${
                    filter === value ? "bg-surface-hover font-medium text-foreground" : "text-muted hover:text-foreground"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("Search name, email, phone or message")}
              aria-label={t("Search conversations")}
              className={`${inputClass} w-full`}
            />
          </div>
          <div ref={listRef} onKeyDown={handleListKey} className="min-h-0 flex-1 overflow-y-auto">
            {listError && (
              <div className="px-4 py-3">
                <ErrorNote error={listError} />
              </div>
            )}
            {conversations === null ? (
              !listError && <p className="px-4 py-6 text-sm text-muted">{t("Loading…")}</p>
            ) : conversations.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted">{t("No conversations here.")}</p>
            ) : (
              conversations.map((c) => (
                <button
                  key={c.id}
                  data-id={c.id}
                  type="button"
                  onClick={() => open(c.id)}
                  aria-current={c.id === activeId ? "true" : undefined}
                  className={`block w-full border-b border-border px-4 py-3 text-left ${
                    c.id === activeId ? "bg-surface-hover" : "hover:bg-surface-hover"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    {c.unreadCount > 0 && (
                      <span className="h-2 w-2 shrink-0 rounded-full bg-accent" aria-label={t("Unread")} role="img" />
                    )}
                    <span
                      className={`min-w-0 flex-1 truncate text-sm text-foreground ${c.unreadCount > 0 ? "font-semibold" : "font-medium"}`}
                    >
                      {c.contact.displayName}
                    </span>
                    <span className="shrink-0 text-[11px] text-zinc-500">{formatShortTime(c.updatedAt, locale, now)}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    <ChannelBadge channel={c.channel} />
                    {c.assessment && c.assessment.urgency !== "NORMAL" && <LevelBadge level={c.assessment.urgency} />}
                    {c.hasDraft && <Badge className="border-accent/40 text-accent">{t("Draft ready")}</Badge>}
                  </div>
                  {c.lastMessage && (
                    <p className="mt-1 truncate text-xs text-muted">
                      {c.lastMessage.direction === "OUTBOUND" ? t("You: ") : ""}
                      {c.lastMessage.body}
                    </p>
                  )}
                </button>
              ))
            )}
          </div>
        </div>

        {/* Thread */}
        <div className={`min-h-0 flex-col ${activeId ? "flex" : "hidden sm:flex"}`}>
          {!activeId ? (
            <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted">
              {t("Select a conversation to read and reply.")}
            </div>
          ) : !shown ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-sm text-muted">
              {detailError ? <ErrorNote error={detailError} /> : t("Loading…")}
            </div>
          ) : (
            <>
              {detailError && (
                <div className="border-b border-border px-4 py-2">
                  <ErrorNote error={detailError} />
                </div>
              )}
              <Thread
                key={shown.id}
                detail={shown}
                me={me}
                members={members}
                now={now}
                copilotOpen={copilotOpen}
                onToggleCopilot={() => setCopilotOpen((v) => !v)}
                onBack={() => open(null)}
                onReload={reloadAll}
              />
            </>
          )}
        </div>

        {/* Copilot: a third column on wide screens, an overlay on small ones. */}
        {shown && copilotOpen && (
          <aside
            aria-label={t("Copilot")}
            className="absolute inset-0 z-10 flex min-h-0 flex-col bg-background lg:static lg:z-auto lg:border-l lg:border-border"
          >
            <Copilot detail={shown} now={now} onClose={() => setCopilotOpen(false)} onReload={reloadAll} />
          </aside>
        )}
      </div>
    </div>
  );
}
