"use client";

/**
 * The right pane of the lead inbox: what Carla made of the conversation,
 * suggested next steps, open tasks and a way to correct her assessment.
 */

import Link from "next/link";
import { useState } from "react";
import { useI18n } from "@/lib/i18n/provider";
import {
  api,
  Badge,
  buttonClass,
  errorText,
  inputClass,
  INTENTS,
  LevelBadge,
  primaryButtonClass,
  URGENCIES,
  useLeadLabels,
  type Assessment,
  type ConversationDetail,
  type NextAction,
} from "@/components/leads/shared";
import { QuickAddTask, TaskRow } from "@/components/leads/task-pieces";

const SENTIMENTS = ["positive", "neutral", "negative"] as const;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-right text-sm text-foreground">{children}</dd>
    </div>
  );
}

export default function Copilot({
  detail,
  now,
  onClose,
  onReload,
}: {
  detail: ConversationDetail;
  now: number;
  onClose: () => void;
  onReload: () => Promise<void>;
}) {
  const { t } = useI18n();
  const labels = useLeadLabels();
  const a = detail.assessment;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [correcting, setCorrecting] = useState(false);

  async function askCarla() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/leads/conversations/${detail.id}/actions`, { method: "POST", body: { action: "assist" } });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
      await onReload();
    }
  }

  async function addActionTask(action: NextAction) {
    setBusy(true);
    setError(null);
    try {
      await api("/api/leads/tasks", {
        method: "POST",
        body: {
          title: action.label,
          dueAt: action.dueInHours != null ? new Date(now + action.dueInHours * 3_600_000).toISOString() : undefined,
          contactId: detail.contact.id,
          conversationId: detail.id,
        },
      });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
      await onReload();
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">{t("Copilot")}</h2>
        <button type="button" onClick={onClose} className="text-sm text-muted hover:text-foreground">
          {t("Hide")}
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
        <Link href={`/leads/contacts/${detail.contact.id}`} className="block text-sm font-medium text-foreground hover:underline">
          {t("Open contact profile")}
        </Link>

        {error && <p role="alert" className="text-xs text-error">{error}</p>}

        {!a ? (
          <p className="text-sm text-muted">{t("Carla has not assessed this conversation yet.")}</p>
        ) : (
          <section className="space-y-2">
            <p className="whitespace-pre-wrap text-sm text-foreground">{a.summary}</p>
            <dl className="divide-y divide-border">
              <Row label={t("Intent")}>{labels.intent(a.intent)}</Row>
              <Row label={t("Urgency")}>
                <LevelBadge level={a.urgency} />
              </Row>
              {a.sentiment && <Row label={t("Sentiment")}>{labels.sentiment(a.sentiment)}</Row>}
              {a.leadScore != null && <Row label={t("Lead score")}>{a.leadScore}</Row>}
              {a.confidence != null && (
                <Row label={t("Confidence")}>{`${Math.round(a.confidence * 100)}%`}</Row>
              )}
            </dl>
            {correcting ? (
              <CorrectionForm
                assessment={a}
                onDone={async () => {
                  setCorrecting(false);
                  await onReload();
                }}
                onCancel={() => setCorrecting(false)}
              />
            ) : (
              <button type="button" onClick={() => setCorrecting(true)} className="text-xs text-muted hover:text-foreground hover:underline">
                {t("Correct this")}
              </button>
            )}
          </section>
        )}

        <button type="button" disabled={busy} onClick={() => void askCarla()} className={buttonClass}>
          {t("Ask Carla again")}
        </button>

        {a?.nextActions && a.nextActions.length > 0 && (
          <section>
            <h3 className="mb-1 text-xs font-semibold text-foreground">{t("Next actions")}</h3>
            <ul className="space-y-2">
              {a.nextActions.map((action, i) => (
                <li key={`${action.action}-${i}`} className="rounded border border-border p-2">
                  <p className="text-sm text-foreground">{action.label}</p>
                  {action.reason && <p className="mt-0.5 text-xs text-muted">{action.reason}</p>}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void addActionTask(action)}
                    className="mt-1 text-xs text-muted hover:text-foreground hover:underline"
                  >
                    {action.dueInHours != null
                      ? t("Add as task, due in {hours} h", { hours: action.dueInHours })
                      : t("Add as task")}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {a?.evidence && a.evidence.length > 0 && (
          <section>
            <h3 className="mb-1 text-xs font-semibold text-foreground">{t("Evidence")}</h3>
            <ul className="list-disc space-y-1 pl-5 text-xs text-muted">
              {a.evidence.map((ev, i) => (
                <li key={i}>
                  {ev.claim}
                  {ev.sourceRef ? <span className="text-zinc-500">{` (${ev.sourceRef})`}</span> : null}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-[11px] text-zinc-500">
              <Badge>{a.producer}</Badge>
            </p>
          </section>
        )}

        <section>
          <h3 className="mb-1 text-xs font-semibold text-foreground">{t("Open tasks")}</h3>
          {detail.tasks.length === 0 ? (
            <p className="text-xs text-muted">{t("No open tasks.")}</p>
          ) : (
            <ul className="divide-y divide-border">
              {detail.tasks.map((task) => (
                <TaskRow key={task.id} task={task} now={now} showContact={false} onChanged={() => void onReload()} />
              ))}
            </ul>
          )}
          <div className="mt-2">
            <QuickAddTask compact contactId={detail.contact.id} conversationId={detail.id} onCreated={() => void onReload()} />
          </div>
        </section>
      </div>
    </div>
  );
}

/** Sends a correction of Carla's assessment. Only changed fields are sent. */
function CorrectionForm({
  assessment,
  onDone,
  onCancel,
}: {
  assessment: Assessment;
  onDone: () => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const labels = useLeadLabels();
  const [intent, setIntent] = useState(assessment.intent);
  const [urgency, setUrgency] = useState(assessment.urgency);
  const [sentiment, setSentiment] = useState(assessment.sentiment ?? "");
  const [leadScore, setLeadScore] = useState(assessment.leadScore == null ? "" : String(assessment.leadScore));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const intentOptions = INTENTS.includes(assessment.intent) ? INTENTS : [assessment.intent, ...INTENTS];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const corrected: Record<string, string | number> = {};
    if (intent !== assessment.intent) corrected.intent = intent;
    if (urgency !== assessment.urgency) corrected.urgency = urgency;
    if (sentiment && sentiment !== assessment.sentiment) corrected.sentiment = sentiment;
    const score = leadScore === "" ? null : Number(leadScore);
    if (score !== null && Number.isInteger(score) && score !== assessment.leadScore) corrected.leadScore = score;
    if (Object.keys(corrected).length === 0) {
      onCancel();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api("/api/leads/feedback", {
        method: "POST",
        body: {
          targetKind: "ASSESSMENT",
          targetId: assessment.id,
          corrected,
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        },
      });
      await onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-2 rounded border border-border p-2">
      <label className="block text-xs text-muted">
        {t("Intent")}
        <select value={intent} onChange={(e) => setIntent(e.target.value)} className={`${inputClass} mt-1 w-full`}>
          {intentOptions.map((i) => (
            <option key={i} value={i}>
              {labels.intent(i)}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-xs text-muted">
        {t("Urgency")}
        <select value={urgency} onChange={(e) => setUrgency(e.target.value)} className={`${inputClass} mt-1 w-full`}>
          {URGENCIES.map((u) => (
            <option key={u} value={u}>
              {labels.level(u)}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-xs text-muted">
        {t("Sentiment")}
        <select value={sentiment} onChange={(e) => setSentiment(e.target.value)} className={`${inputClass} mt-1 w-full`}>
          <option value="">{t("Not set")}</option>
          {SENTIMENTS.map((s) => (
            <option key={s} value={s}>
              {labels.sentiment(s)}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-xs text-muted">
        {t("Lead score")}
        <input
          type="number"
          min={0}
          max={100}
          value={leadScore}
          onChange={(e) => setLeadScore(e.target.value)}
          className={`${inputClass} mt-1 w-full`}
        />
      </label>
      <label className="block text-xs text-muted">
        {t("Why (optional)")}
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} className={`${inputClass} mt-1 w-full`} />
      </label>
      {error && <p role="alert" className="text-xs text-error">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className={primaryButtonClass}>
          {t("Save correction")}
        </button>
        <button type="button" onClick={onCancel} className={buttonClass}>
          {t("Cancel")}
        </button>
      </div>
    </form>
  );
}
