"use client";

/**
 * Tasks
 *
 * Open follow-ups grouped by when they are due, with a quick-add form.
 */

import { useCallback, useState } from "react";
import { useI18n } from "@/lib/i18n/provider";
import { api, ErrorNote, errorText, LeadsHeader, useNow, usePolling, type Task } from "@/components/leads/shared";
import { QuickAddTask, TaskRow } from "@/components/leads/task-pieces";

type Group = "overdue" | "today" | "upcoming" | "none";

function groupOf(task: Task, now: number): Group {
  if (!task.dueAt) return "none";
  const due = new Date(task.dueAt);
  if (due.getTime() < now) return "overdue";
  return due.toDateString() === new Date(now).toDateString() ? "today" : "upcoming";
}

export default function TasksPage() {
  const { t } = useI18n();
  const now = useNow();
  const [mine, setMine] = useState(true);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api<{ tasks: Task[] }>(`/api/leads/tasks?status=OPEN${mine ? "&mine=1" : ""}`);
      setTasks(res.tasks);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, [mine]);

  usePolling(load, null);

  const groups: [Group, string][] = [
    ["overdue", t("Overdue")],
    ["today", t("Today")],
    ["upcoming", t("Upcoming")],
    ["none", t("No date")],
  ];

  return (
    <div className="space-y-4">
      <LeadsHeader title={t("Tasks")}>
        <div role="tablist" aria-label={t("Whose tasks")} className="flex gap-1 text-sm">
          {(
            [
              [true, t("Mine")],
              [false, t("All")],
            ] as const
          ).map(([value, label]) => (
            <button
              key={label}
              type="button"
              role="tab"
              aria-selected={mine === value}
              onClick={() => setMine(value)}
              className={`rounded px-3 py-1.5 ${
                mine === value ? "bg-surface-hover font-medium text-foreground" : "text-muted hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </LeadsHeader>

      <div className="rounded border border-border p-3">
        <QuickAddTask onCreated={() => void load()} />
      </div>

      <ErrorNote error={error} />
      {tasks === null ? (
        !error && <p className="text-sm text-muted">{t("Loading…")}</p>
      ) : tasks.length === 0 ? (
        <p className="text-sm text-muted">{t("No open tasks.")}</p>
      ) : (
        groups.map(([group, label]) => {
          const items = tasks
            .filter((task) => groupOf(task, now) === group)
            .sort((a, b) => (a.dueAt ?? "").localeCompare(b.dueAt ?? ""));
          if (items.length === 0) return null;
          return (
            <section key={group}>
              <h2 className={`text-sm font-semibold ${group === "overdue" ? "text-error" : "text-foreground"}`}>
                {label} <span className="font-normal text-muted">{items.length}</span>
              </h2>
              <ul className="divide-y divide-border">
                {items.map((task) => (
                  <TaskRow key={task.id} task={task} now={now} onChanged={() => void load()} />
                ))}
              </ul>
            </section>
          );
        })
      )}
    </div>
  );
}
