"use client";

/**
 * Pipeline
 *
 * Kanban board of open deals, one column per stage. A card moves with the
 * stage picker on it. On a version conflict the board reloads.
 */

import Link from "next/link";
import { useCallback, useState } from "react";
import { useI18n } from "@/lib/i18n/provider";
import {
  api,
  ApiError,
  ErrorNote,
  errorText,
  formatMoney,
  inputClass,
  LeadsHeader,
  usePolling,
} from "@/components/leads/shared";

type Stage = { key: string; name: string; position: number; kind: "OPEN" | "WON" | "LOST" };
type Opportunity = {
  id: string;
  stageKey: string;
  title: string;
  valueCents: number | null;
  currency: string;
  outcome: string;
  version: number;
  contact: { id: string; displayName: string; leadScore: number | null };
  updatedAt: string;
};
type Board = { pipeline: { id: string; name: string; stages: Stage[] }; opportunities: Opportunity[] };

export default function PipelinePage() {
  const { t, locale } = useI18n();
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setBoard(await api<Board>("/api/leads/board"));
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  usePolling(load, null);

  async function move(opp: Opportunity, stageKey: string) {
    if (stageKey === opp.stageKey) return;
    setMovingId(opp.id);
    setError(null);
    // Move the card right away; the reload confirms or reverts it.
    setBoard((b) =>
      b && { ...b, opportunities: b.opportunities.map((o) => (o.id === opp.id ? { ...o, stageKey } : o)) },
    );
    try {
      await api(`/api/leads/opportunities/${opp.id}`, {
        method: "PATCH",
        body: { version: opp.version, stageKey },
      });
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409
          ? t("Someone else changed this deal. The board was reloaded.")
          : errorText(err),
      );
    } finally {
      setMovingId(null);
      await load();
    }
  }

  const stages = board ? [...board.pipeline.stages].sort((a, b) => a.position - b.position) : [];

  return (
    <div className="space-y-4">
      <LeadsHeader title={board?.pipeline.name ?? t("Pipeline")} />
      <ErrorNote error={error} />
      {!board ? (
        !error && <p className="text-sm text-muted">{t("Loading…")}</p>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {stages.map((stage) => {
            const cards = board.opportunities.filter((o) => o.stageKey === stage.key);
            const total = cards.reduce((sum, o) => sum + (o.valueCents ?? 0), 0);
            const currency = cards[0]?.currency ?? "CAD";
            return (
              <section
                key={stage.key}
                aria-label={stage.name}
                className="flex w-64 shrink-0 flex-col rounded border border-border bg-surface"
              >
                <header className="border-b border-border px-3 py-2">
                  <h2 className="text-sm font-semibold text-foreground">{stage.name}</h2>
                  <p className="text-xs text-muted">
                    {t("{count} deals", { count: cards.length })}
                    {total > 0 ? ` · ${formatMoney(total, currency, locale)}` : ""}
                  </p>
                </header>
                <ul className="min-h-16 flex-1 space-y-2 p-2">
                  {cards.map((o) => (
                    <li key={o.id} className="rounded border border-border bg-background p-2">
                      <Link
                        href={`/leads/contacts/${o.contact.id}`}
                        className="block truncate text-sm font-medium text-foreground hover:underline"
                      >
                        {o.contact.displayName}
                      </Link>
                      <p className="truncate text-xs text-muted">{o.title}</p>
                      <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted">
                        <span>{formatMoney(o.valueCents, o.currency, locale)}</span>
                        {o.contact.leadScore != null && (
                          <span>{t("Score {score}", { score: o.contact.leadScore })}</span>
                        )}
                      </div>
                      <select
                        value={o.stageKey}
                        disabled={movingId === o.id}
                        onChange={(e) => void move(o, e.target.value)}
                        aria-label={t("Move {title} to stage", { title: o.title })}
                        className={`${inputClass} mt-2 w-full py-1 text-xs`}
                      >
                        {stages.map((s) => (
                          <option key={s.key} value={s.key}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
