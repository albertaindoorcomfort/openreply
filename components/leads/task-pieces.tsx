"use client";

import Link from "next/link";
import { useState } from "react";
import { useI18n } from "@/lib/i18n/provider";
import {
  api,
  buttonClass,
  errorText,
  formatDateTime,
  inputClass,
  LevelBadge,
  PRIORITIES,
  useLeadLabels,
  type Task,
} from "@/components/leads/shared";

/** One task with a done checkbox. Calls onChanged after a successful update. */
export function TaskRow({
  task,
  now,
  onChanged,
  showContact = true,
}: {
  task: Task;
  now: number;
  onChanged: () => void;
  showContact?: boolean;
}) {
  const { t, locale } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const done = task.status === "DONE";
  const overdue = !done && task.dueAt !== null && new Date(task.dueAt).getTime() < now;

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/leads/tasks/${task.id}`, {
        method: "PATCH",
        body: { version: task.version, status: done ? "OPEN" : "DONE" },
      });
      onChanged();
    } catch (err) {
      setError(errorText(err));
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex items-start gap-3 py-2">
      <input
        type="checkbox"
        checked={done}
        disabled={busy}
        onChange={() => void toggle()}
        aria-label={t("Mark \"{title}\" done", { title: task.title })}
        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-accent)]"
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`text-sm ${done ? "text-muted line-through" : "text-foreground"}`}>{task.title}</span>
          {task.priority !== "NORMAL" && <LevelBadge level={task.priority} />}
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted">
          {task.dueAt && (
            <span className={overdue ? "text-error" : undefined}>
              {overdue ? t("Overdue: {time}", { time: formatDateTime(task.dueAt, locale) }) : t("Due {time}", { time: formatDateTime(task.dueAt, locale) })}
            </span>
          )}
          {showContact && task.contact && (
            <Link href={`/leads/contacts/${task.contact.id}`} className="hover:text-foreground hover:underline">
              {task.contact.displayName}
            </Link>
          )}
          {task.conversationId && (
            <Link href={`/leads?c=${task.conversationId}`} className="hover:text-foreground hover:underline">
              {t("Open conversation")}
            </Link>
          )}
        </div>
        {error && <p role="alert" className="mt-1 text-xs text-error">{error}</p>}
      </div>
    </li>
  );
}

/** Small form that creates a task. Due date is optional. */
export function QuickAddTask({
  contactId,
  conversationId,
  onCreated,
  compact = false,
}: {
  contactId?: string;
  conversationId?: string;
  onCreated: () => void;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const labels = useLeadLabels();
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [priority, setPriority] = useState("NORMAL");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = title.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/leads/tasks", {
        method: "POST",
        body: {
          title: text,
          dueAt: due ? new Date(due).toISOString() : undefined,
          priority,
          contactId,
          conversationId,
        },
      });
      setTitle("");
      setDue("");
      setPriority("NORMAL");
      onCreated();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-2">
      <div className={`flex gap-2 ${compact ? "flex-col" : "flex-col sm:flex-row"}`}>
        <label className="sr-only" htmlFor={`task-title-${conversationId ?? contactId ?? "new"}`}>
          {t("New task")}
        </label>
        <input
          id={`task-title-${conversationId ?? contactId ?? "new"}`}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t("Add a task")}
          maxLength={200}
          className={`${inputClass} min-w-0 flex-1`}
        />
        <div className="flex gap-2">
          <input
            type="datetime-local"
            value={due}
            onChange={(e) => setDue(e.target.value)}
            aria-label={t("Due date")}
            className={`${inputClass} min-w-0 flex-1`}
          />
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            aria-label={t("Priority")}
            className={inputClass}
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {labels.level(p)}
              </option>
            ))}
          </select>
          <button type="submit" disabled={busy || !title.trim()} className={buttonClass}>
            {t("Add")}
          </button>
        </div>
      </div>
      {error && <p role="alert" className="text-xs text-error">{error}</p>}
    </form>
  );
}
