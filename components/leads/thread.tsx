"use client";

/**
 * The middle pane of the lead inbox: conversation header with handoff
 * controls, the message thread, Carla's proposed draft and the composer.
 *
 * The parent remounts this component (key = conversation id), so composer
 * state, the reply lock and the pending idempotency key never leak between
 * conversations.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/provider";
import {
  api,
  ApiError,
  Badge,
  buttonClass,
  ChannelBadge,
  errorText,
  formatDateTime,
  inputClass,
  primaryButtonClass,
  useLeadLabels,
  type ConversationDetail,
  type Draft,
  type Member,
  type Message,
} from "@/components/leads/shared";

const LOCK_RENEW_MS = 60_000;

type ComposerMode = "reply" | "note" | "coach";
type LockResponse = { held: boolean; lockUserId: string | null; lockExpiresAt: string | null };

function newestDraft(drafts: Draft[], status: string): Draft | null {
  return (
    drafts
      .filter((d) => d.status === status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null
  );
}

export default function Thread({
  detail,
  me,
  members,
  now,
  copilotOpen,
  onToggleCopilot,
  onBack,
  onReload,
}: {
  detail: ConversationDetail;
  me: string;
  members: Member[];
  now: number;
  copilotOpen: boolean;
  onToggleCopilot: () => void;
  onBack: () => void;
  onReload: () => Promise<void>;
}) {
  const { t, locale } = useI18n();
  const labels = useLeadLabels();
  const [mode, setMode] = useState<ComposerMode>("reply");
  const [text, setText] = useState("");
  const [fromDraftId, setFromDraftId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lockBlockedUntil, setLockBlockedUntil] = useState(0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lockHeld = useRef(false);
  const lastTypedAt = useRef(0);
  // One idempotency key per send click, reused if the same send is retried
  // after a network failure so the server never sends twice.
  const pendingSend = useRef<{ signature: string; key: string } | null>(null);

  const conversationId = detail.id;
  const proposed = newestDraft(detail.drafts, "PROPOSED");
  const troubleDrafts = detail.drafts.filter((d) => d.status !== "PROPOSED");
  const memberName = (id: string | null) => members.find((m) => m.id === id)?.name ?? "";

  const lockedByOther =
    lockBlockedUntil > now ||
    (detail.lockUserId !== null &&
      detail.lockUserId !== me &&
      detail.lockExpiresAt !== null &&
      new Date(detail.lockExpiresAt).getTime() > now);

  // ---- Reply lock -------------------------------------------------------

  const acquireLock = useCallback(async () => {
    try {
      const res = await api<LockResponse>(`/api/leads/conversations/${conversationId}/actions`, {
        method: "POST",
        body: { action: "lock" },
      });
      lockHeld.current = res.held;
      setLockBlockedUntil(res.held || !res.lockExpiresAt ? 0 : new Date(res.lockExpiresAt).getTime());
    } catch {
      // The send itself re-checks the lock; a failed lock call is not fatal.
    }
  }, [conversationId]);

  const releaseLock = useCallback(async () => {
    if (!lockHeld.current) return;
    lockHeld.current = false;
    try {
      await api(`/api/leads/conversations/${conversationId}/actions`, {
        method: "POST",
        body: { action: "unlock" },
      });
    } catch {
      // The lock expires on its own.
    }
  }, [conversationId]);

  // Renew while the person keeps typing; release when the pane goes away.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (lockHeld.current && Date.now() - lastTypedAt.current < LOCK_RENEW_MS) void acquireLock();
    }, LOCK_RENEW_MS);
    return () => {
      window.clearInterval(timer);
      void releaseLock();
    };
  }, [acquireLock, releaseLock]);

  // Keep the newest message in view.
  const messageCount = detail.messages.length;
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messageCount]);

  // ---- Actions ----------------------------------------------------------

  async function runAction(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/leads/conversations/${conversationId}/actions`, { method: "POST", body });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
      await onReload();
    }
  }

  async function send(body: string, draftId: string | null) {
    const trimmed = body.trim();
    if (!trimmed || busy) return;
    const signature = `${draftId ?? ""}\n${trimmed}`;
    if (pendingSend.current?.signature !== signature) {
      pendingSend.current = { signature, key: crypto.randomUUID() };
    }
    const basedOn = [...detail.messages].reverse().find((m) => m.direction !== "INTERNAL");
    setBusy(true);
    setError(null);
    try {
      await api(`/api/leads/conversations/${conversationId}/send`, {
        method: "POST",
        body: {
          body: trimmed,
          idempotencyKey: pendingSend.current.key,
          basedOnMessageId: basedOn?.id ?? null,
          ...(draftId ? { fromDraftId: draftId } : {}),
        },
      });
      pendingSend.current = null;
      setText("");
      setFromDraftId(null);
      void releaseLock();
    } catch (err) {
      // The server gave a definite answer, so a new click is a new send.
      if (err instanceof ApiError && err.status > 0 && err.status < 500) pendingSend.current = null;
      if (err instanceof ApiError && err.code === "DRAFT_STALE") {
        setError(t("A newer message arrived. Read it, then try again."));
      } else if (err instanceof ApiError && err.code === "LOCKED") {
        setError(t("Someone else is replying"));
      } else {
        setError(errorText(err));
      }
    } finally {
      setBusy(false);
      await onReload();
    }
  }

  async function postInternal() {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/leads/conversations/${conversationId}/actions`, {
        method: "POST",
        body: { action: mode === "coach" ? "coach" : "note", body },
      });
      setText("");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
      await onReload();
    }
  }

  async function discardDraft(draft: Draft) {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/leads/drafts/${draft.id}`, { method: "DELETE" });
      if (fromDraftId === draft.id) setFromDraftId(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
      await onReload();
    }
  }

  function editDraft(draft: Draft) {
    setMode("reply");
    setText(draft.body);
    setFromDraftId(draft.id);
    textareaRef.current?.focus();
  }

  function submit() {
    if (mode === "reply") void send(text, fromDraftId);
    else void postInternal();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  // ---- Render -----------------------------------------------------------

  const windowEnds = detail.replyWindowEndsAt ? new Date(detail.replyWindowEndsAt).getTime() : null;
  const replyDisabled = mode === "reply" && lockedByOther;

  const placeholder =
    mode === "reply"
      ? t("Reply to the customer (Enter to send, Shift+Enter for a new line)")
      : mode === "note"
        ? t("Note for your team. The customer does not see it.")
        : t("Private guidance for Carla. The customer does not see it.");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header */}
      <div className="shrink-0 space-y-2 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onBack}
            className="-ml-1 rounded px-2 py-1 text-sm text-muted hover:text-foreground sm:hidden"
            aria-label={t("Back to conversations")}
          >
            {t("Back")}
          </button>
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
            {detail.contact.displayName}
            {detail.subject ? <span className="font-normal text-muted">{` · ${detail.subject}`}</span> : null}
          </h2>
          <ChannelBadge channel={detail.channel} />
          <Badge>{labels.mode(detail.mode)}</Badge>
          <button
            type="button"
            onClick={onToggleCopilot}
            aria-pressed={copilotOpen}
            className={buttonClass}
          >
            {t("Copilot")}
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {detail.mode === "SUPERVISED" && (
            <button type="button" disabled={busy} onClick={() => void runAction({ action: "takeover" })} className={buttonClass}>
              {t("Take over")}
            </button>
          )}
          {detail.mode === "HUMAN" && (
            <button type="button" disabled={busy} onClick={() => void runAction({ action: "resume" })} className={buttonClass}>
              {t("Hand back to Carla")}
            </button>
          )}
          <label className="flex items-center gap-1.5 text-xs text-muted">
            {t("Assign")}
            <select
              value={detail.ownerUserId ?? ""}
              disabled={busy}
              onChange={(e) =>
                void runAction({ action: "assign", ownerUserId: e.target.value || null, version: detail.version })
              }
              className={inputClass}
            >
              <option value="">{t("Nobody")}</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id === me ? t("Me ({name})", { name: m.name }) : m.name}
                </option>
              ))}
            </select>
          </label>
          {detail.status === "CLOSED" ? (
            <button type="button" disabled={busy} onClick={() => void runAction({ action: "reopen" })} className={buttonClass}>
              {t("Reopen")}
            </button>
          ) : (
            <button type="button" disabled={busy} onClick={() => void runAction({ action: "close" })} className={buttonClass}>
              {t("Close")}
            </button>
          )}
          {detail.channel === "INSTAGRAM" && windowEnds !== null && (
            <span className={`text-xs ${windowEnds > now ? "text-muted" : "text-error"}`}>
              {windowEnds > now
                ? t("Reply window closes {time}", { time: formatDateTime(detail.replyWindowEndsAt, locale) })
                : t("Reply window closed")}
            </span>
          )}
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4" aria-live="polite">
        {detail.messages.length === 0 ? (
          <p className="text-sm text-muted">{t("No messages.")}</p>
        ) : (
          detail.messages.map((m) => <MessageBubble key={m.id} message={m} memberName={memberName} />)
        )}
      </div>

      {/* Drafts */}
      {troubleDrafts.length > 0 && (
        <div className="shrink-0 space-y-1 border-t border-border px-4 py-2">
          {troubleDrafts.map((d) => (
            <p key={d.id} className={`text-xs ${d.status === "SENDING" ? "text-muted" : "text-error"}`}>
              {d.status === "SENDING"
                ? t("A reply is being sent.")
                : d.status === "SEND_UNCONFIRMED"
                  ? t("A reply may not have been delivered. Check the channel before sending again.")
                  : t("A reply failed to send: {reason}", { reason: d.errorMessage ?? d.status })}
            </p>
          ))}
        </div>
      )}
      {proposed && (
        <div className="max-h-[40%] shrink-0 overflow-y-auto border-t border-border bg-surface px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs font-semibold text-foreground">{t("Carla's draft")}</p>
            {proposed.confidence != null && (
              <Badge>{t("Confidence {percent}%", { percent: Math.round(proposed.confidence * 100) })}</Badge>
            )}
            {fromDraftId === proposed.id && <Badge>{t("Editing")}</Badge>}
          </div>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm text-foreground">{proposed.body}</p>
          {proposed.rationale && (
            <p className="mt-1 text-xs text-muted">
              {t("Why: {reason}", { reason: proposed.rationale })}
            </p>
          )}
          {proposed.evidence && proposed.evidence.length > 0 && (
            <details className="mt-1 text-xs text-muted">
              <summary className="cursor-pointer hover:text-foreground">
                {t("Evidence ({count})", { count: proposed.evidence.length })}
              </summary>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {proposed.evidence.map((ev, i) => (
                  <li key={i}>
                    {ev.claim}
                    {ev.sourceRef ? <span className="text-zinc-500">{` (${ev.sourceRef})`}</span> : null}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy || lockedByOther}
              onClick={() => void send(proposed.body, proposed.id)}
              className={primaryButtonClass}
            >
              {t("Approve and send")}
            </button>
            <button type="button" disabled={busy} onClick={() => editDraft(proposed)} className={buttonClass}>
              {t("Edit")}
            </button>
            <button type="button" disabled={busy} onClick={() => void discardDraft(proposed)} className={buttonClass}>
              {t("Discard")}
            </button>
          </div>
        </div>
      )}

      {/* Composer */}
      <div className="shrink-0 border-t border-border p-3">
        <div role="tablist" aria-label={t("Message type")} className="mb-2 flex gap-1 text-xs">
          {(
            [
              ["reply", t("Reply (customer)")],
              ["note", t("Note (staff)")],
              ["coach", t("Coach Carla (private)")],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={mode === value}
              onClick={() => setMode(value)}
              className={`rounded px-2 py-1 ${
                mode === value ? "bg-surface-hover font-medium text-foreground" : "text-muted hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {mode === "reply" && lockedByOther && (
          <p role="status" className="mb-2 text-xs text-warning">
            {t("Someone else is replying")}
          </p>
        )}
        {error && (
          <p role="alert" className="mb-2 text-xs text-error">
            {error}
          </p>
        )}
        <div className="flex items-end gap-2">
          <label htmlFor={`composer-${conversationId}`} className="sr-only">
            {placeholder}
          </label>
          <textarea
            id={`composer-${conversationId}`}
            ref={textareaRef}
            value={text}
            rows={2}
            onChange={(e) => {
              setText(e.target.value);
              if (mode === "reply") {
                lastTypedAt.current = Date.now();
                if (!lockHeld.current) void acquireLock();
              }
            }}
            onFocus={() => {
              if (mode === "reply") void acquireLock();
            }}
            onBlur={() => {
              if (!text.trim()) void releaseLock();
            }}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            className={`max-h-40 min-h-[44px] flex-1 resize-y rounded-lg border px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:outline-none ${
              mode === "reply" ? "border-border bg-background focus:border-accent/40" : "border-amber-300 bg-amber-50"
            }`}
          />
          <button
            type="button"
            onClick={submit}
            disabled={busy || !text.trim() || replyDisabled}
            className={primaryButtonClass}
          >
            {busy ? t("Sending…") : mode === "reply" ? t("Send") : t("Save")}
          </button>
        </div>
        {mode === "reply" && fromDraftId && (
          <button
            type="button"
            onClick={() => setFromDraftId(null)}
            className="mt-1 text-xs text-muted hover:text-foreground hover:underline"
          >
            {t("Send as my own reply instead of Carla's edited draft")}
          </button>
        )}
      </div>
    </div>
  );
}

function MessageBubble({ message: m, memberName }: { message: Message; memberName: (id: string | null) => string }) {
  const { t, locale } = useI18n();
  const author =
    m.authorKind === "AGENT" ? "Carla" : m.authorKind === "USER" ? memberName(m.authorId) : "";

  if (m.direction === "INTERNAL") {
    return (
      <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-foreground">
        <p className="text-[11px] font-medium text-amber-800">
          {m.kind === "COACHING" ? t("Coaching for Carla") : t("Staff note")}
          {" · "}
          {t("Only staff can see this")}
          {author ? ` · ${author}` : ""}
        </p>
        <p className="mt-1 whitespace-pre-wrap break-words">{m.body}</p>
        <p className="mt-1 text-[10px] text-zinc-500">{formatDateTime(m.occurredAt, locale)}</p>
      </div>
    );
  }

  if (m.kind === "SYSTEM") {
    return (
      <p className="text-center text-xs text-muted">
        {m.body} · {formatDateTime(m.occurredAt, locale)}
      </p>
    );
  }

  const outbound = m.direction === "OUTBOUND";
  return (
    <div className={`flex ${outbound ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
          outbound ? "bg-accent text-white" : "border border-border bg-surface text-foreground"
        }`}
      >
        {(m.kind === "TRANSCRIPT" || m.kind === "VOICEMAIL") && (
          <p className={`mb-1 text-[10px] font-medium ${outbound ? "text-white/80" : "text-muted"}`}>
            {m.kind === "VOICEMAIL" ? t("Voicemail") : t("Call transcript")}
          </p>
        )}
        <p className="whitespace-pre-wrap break-words">{m.body}</p>
        <p className={`mt-1 text-[10px] ${outbound ? "text-white/70" : "text-zinc-500"}`}>
          {author ? `${author} · ` : ""}
          {formatDateTime(m.occurredAt, locale)}
        </p>
      </div>
    </div>
  );
}
