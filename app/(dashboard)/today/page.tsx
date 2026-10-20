"use client";

/**
 * Today
 *
 * The start-of-day view for staff: what is waiting on a person, tasks due,
 * new leads from the last day and a pipeline snapshot.
 */

import Link from "next/link";
import { useCallback, useState } from "react";
import { useI18n } from "@/lib/i18n/provider";
import {
  api,
  ChannelBadge,
  ErrorNote,
  errorText,
  formatMoney,
  formatShortTime,
  humanize,
  useNow,
  type ContactRef,
  type Task,
  usePolling,
} from "@/components/leads/shared";
import { TaskRow } from "@/components/leads/task-pieces";

type TodayResponse = {
  counts: { awaitingReply: number; draftsToReview: number; overdue: number };
  myTasks: Task[];
  newLeads: { id: string; displayName: string; source: string | null; leadScore: number | null; stageKey: string; createdAt: string }[];
  handoffs: { id: string; channel: string; subject: string | null; updatedAt: string; contact: ContactRef }[];
  pipeline: { stageKey: string; count: number; valueCents: number | null }[];
  metrics: { medianFirstResponseMinutes30d: number | null };
};

const POLL_MS = 30_000;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded border border-border bg-background p-4">
      <h2 className="mb-2 text-sm font-semibold text-foreground">{title}</h2>
      {children}
    </section>
  );
}

export default function TodayPage() {
  const { t, locale } = useI18n();
  const now = useNow();
  const [data, setData] = useState<TodayResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<TodayResponse>("/api/leads/today"));
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  usePolling(load, POLL_MS);

  const tiles = data
    ? [
        { label: t("Awaiting reply"), value: data.counts.awaitingReply, href: "/leads" },
        { label: t("Drafts to review"), value: data.counts.draftsToReview, href: "/leads" },
        { label: t("Overdue tasks"), value: data.counts.overdue, href: "/leads/tasks" },
      ]
    : [];

  const median = data?.metrics.medianFirstResponseMinutes30d;

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-foreground">{t("Today")}</h1>
      <ErrorNote error={error} />
      {!data ? (
        !error && <p className="text-sm text-muted">{t("Loading…")}</p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            {tiles.map((tile) => (
              <Link
                key={tile.label}
                href={tile.href}
                className="rounded border border-border bg-surface p-4 hover:bg-surface-hover"
              >
                <p className="text-xs text-muted">{tile.label}</p>
                <p className={`mt-1 text-2xl font-semibold ${tile.value > 0 ? "text-foreground" : "text-muted"}`}>{tile.value}</p>
              </Link>
            ))}
            <div className="rounded border border-border bg-surface p-4">
              <p className="text-xs text-muted">{t("Median first response (30 days)")}</p>
              <p className="mt-1 text-2xl font-semibold text-foreground">
                {median == null ? t("No data yet") : t("{minutes} min", { minutes: Math.round(median) })}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Section title={t("Needs you")}>
              {data.handoffs.length === 0 ? (
                <p className="text-sm text-muted">{t("Nothing needs a person right now.")}</p>
              ) : (
                <ul className="divide-y divide-border">
                  {data.handoffs.map((h) => (
                    <li key={h.id}>
                      <Link href={`/leads?c=${h.id}`} className="flex items-center gap-2 py-2 hover:bg-surface-hover">
                        <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                          {h.contact.displayName}
                          {h.subject ? <span className="text-muted">{` · ${h.subject}`}</span> : null}
                        </span>
                        <ChannelBadge channel={h.channel} />
                        <span className="shrink-0 text-xs text-muted">{formatShortTime(h.updatedAt, locale, now)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title={t("My tasks due today")}>
              {data.myTasks.length === 0 ? (
                <p className="text-sm text-muted">{t("No tasks due today.")}</p>
              ) : (
                <ul className="divide-y divide-border">
                  {data.myTasks.map((task) => (
                    <TaskRow key={task.id} task={task} now={now} onChanged={() => void load()} />
                  ))}
                </ul>
              )}
              <Link href="/leads/tasks" className="mt-2 inline-block text-xs text-muted hover:text-foreground hover:underline">
                {t("All tasks")}
              </Link>
            </Section>

            <Section title={t("New leads in the last 24 hours")}>
              {data.newLeads.length === 0 ? (
                <p className="text-sm text-muted">{t("No new leads.")}</p>
              ) : (
                <ul className="divide-y divide-border">
                  {data.newLeads.map((lead) => (
                    <li key={lead.id}>
                      <Link href={`/leads/contacts/${lead.id}`} className="flex items-center gap-2 py-2 hover:bg-surface-hover">
                        <span className="min-w-0 flex-1 truncate text-sm text-foreground">{lead.displayName}</span>
                        {lead.source && <ChannelBadge channel={lead.source} />}
                        {lead.leadScore != null && (
                          <span className="text-xs text-muted">{t("Score {score}", { score: lead.leadScore })}</span>
                        )}
                        <span className="shrink-0 text-xs text-muted">{formatShortTime(lead.createdAt, locale, now)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title={t("Pipeline")}>
              {data.pipeline.length === 0 ? (
                <p className="text-sm text-muted">{t("No open deals.")}</p>
              ) : (
                <ul className="divide-y divide-border">
                  {data.pipeline.map((s) => (
                    <li key={s.stageKey} className="flex items-center gap-2 py-2 text-sm">
                      <span className="min-w-0 flex-1 truncate text-foreground">{humanize(s.stageKey)}</span>
                      <span className="text-muted">{s.count}</span>
                      {s.valueCents ? (
                        <span className="w-24 text-right text-muted">{formatMoney(s.valueCents, "CAD", locale)}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              <Link href="/leads/pipeline" className="mt-2 inline-block text-xs text-muted hover:text-foreground hover:underline">
                {t("Open pipeline")}
              </Link>
            </Section>
          </div>
        </>
      )}
    </div>
  );
}
