"use client";

/**
 * Contact profile
 *
 * Everything known about one lead: owner, stage and score, identities,
 * consent per channel, conversations, deals, tasks, possible duplicates and
 * the full timeline of what happened.
 */

import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import type { StaticMessageKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/provider";
import {
  api,
  ApiError,
  Badge,
  buttonClass,
  ChannelBadge,
  ErrorNote,
  errorText,
  formatDateTime,
  formatMoney,
  humanize,
  inputClass,
  LeadsHeader,
  useLeadLabels,
  useMembers,
  useNow,
  type Task,
  usePolling,
} from "@/components/leads/shared";
import { QuickAddTask, TaskRow } from "@/components/leads/task-pieces";

type Consent = { id: string; channel: string; status: string; basis: string; source: string; capturedAt: string; withdrawnAt: string | null };
type Contact = {
  id: string;
  displayName: string;
  company: string | null;
  primaryEmail: string | null;
  primaryPhone: string | null;
  ownerUserId: string | null;
  stageKey: string;
  leadScore: number | null;
  source: string | null;
  deletedAt: string | null;
  mergedIntoId: string | null;
  version: number;
  createdAt: string;
  identities: { id: string; kind: string; value: string; verified: boolean }[];
  consents: Consent[];
  conversations: { id: string; channel: string; subject: string | null; status: string; updatedAt: string }[];
  tasks: Task[];
  opportunities: { id: string; title: string; stageKey: string; valueCents: number | null; currency: string; outcome: string }[];
  timeline: { id: string; seq: string; type: string; actorKind: string; actorId: string | null; payload: unknown; occurredAt: string }[];
  duplicates: { id: string; contactId: string; otherContactId: string; reason: string; score: number }[];
};
type Stage = { key: string; name: string; position: number };

const CONSENT_CHANNELS = ["EMAIL", "SMS", "CALL", "DM"] as const;
const CONSENT_LABEL: Record<(typeof CONSENT_CHANNELS)[number], StaticMessageKey> = {
  EMAIL: "Email",
  SMS: "SMS",
  CALL: "Call",
  DM: "Direct messages",
};

const EVENT_LABEL: Record<string, StaticMessageKey> = {
  "contact.created": "Contact created",
  "contact.updated": "Contact updated",
  "contact.deleted": "Contact deleted",
  "contact.restored": "Contact restored",
  "contact.merged": "Contacts merged",
  "identity.linked": "Identity linked",
  "consent.changed": "Consent changed",
  "conversation.created": "Conversation started",
  "conversation.assigned": "Conversation assigned",
  "conversation.mode_changed": "Reply mode changed",
  "conversation.reopened": "Conversation reopened",
  "conversation.closed": "Conversation closed",
  "message.received": "Message received",
  "message.sent": "Message sent",
  "assessment.created": "AIC OS assessed the lead",
  "draft.proposed": "AIC OS proposed a reply",
  "draft.approved": "Reply approved",
  "draft.discarded": "Draft discarded",
  "draft.stale": "Draft out of date",
  "duplicate.flagged": "Possible duplicate found",
  "feedback.recorded": "Correction recorded",
  "opportunity.created": "Deal created",
  "opportunity.updated": "Deal updated",
  "opportunity.stage_changed": "Deal moved",
  "task.created": "Task created",
  "task.updated": "Task updated",
  "task.completed": "Task completed",
};

const ACTOR_LABEL: Record<string, StaticMessageKey> = {
  CONTACT: "Contact",
  USER: "Staff",
  AGENT: "AIC OS",
  SYSTEM: "System",
  SERVICE: "Integration",
};

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded border border-border p-4">
      <h2 className="mb-2 text-sm font-semibold text-foreground">{title}</h2>
      {children}
    </section>
  );
}

export default function ContactPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t, locale } = useI18n();
  const labels = useLeadLabels();
  const now = useNow();
  const { me, members } = useMembers();
  const [contact, setContact] = useState<Contact | null>(null);
  const [stages, setStages] = useState<Stage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setContact(await api<Contact>(`/api/leads/contacts/${id}`));
    } catch (err) {
      setError(errorText(err));
    }
  }, [id]);

  usePolling(load, null);

  useEffect(() => {
    api<{ pipeline: { stages: Stage[] } }>("/api/leads/board")
      .then((b) => setStages([...b.pipeline.stages].sort((x, y) => x.position - y.position)))
      .catch(() => undefined);
  }, []);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "VERSION_CONFLICT"
          ? t("Someone else changed this contact. It was reloaded.")
          : errorText(err),
      );
    } finally {
      setBusy(false);
      await load();
    }
  }

  const patch = (body: Record<string, unknown>) =>
    run(() => api(`/api/leads/contacts/${id}`, { method: "PATCH", body: { version: contact?.version, ...body } }));
  const post = (body: Record<string, unknown>) =>
    run(() => api(`/api/leads/contacts/${id}`, { method: "POST", body }));

  if (!contact) {
    return (
      <div className="space-y-4">
        <LeadsHeader title={t("Contact")} />
        <ErrorNote error={error} />
        {!error && <p className="text-sm text-muted">{t("Loading…")}</p>}
      </div>
    );
  }

  const isAdmin = members.some((m) => m.id === me && (m.role === "OWNER" || m.role === "ADMIN"));
  const latestConsent = (channel: string) => contact.consents.find((c) => c.channel === channel) ?? null;
  const stageName = (key: string) => stages.find((s) => s.key === key)?.name ?? humanize(key);

  return (
    <div className="space-y-4">
      <LeadsHeader title={contact.displayName}>
        {isAdmin && !contact.deletedAt && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (window.confirm(t("Delete this contact? An admin can restore it later.")))
                void run(() => api(`/api/leads/contacts/${id}`, { method: "DELETE" }));
            }}
            className={buttonClass}
          >
            {t("Delete")}
          </button>
        )}
      </LeadsHeader>
      <ErrorNote error={error} />

      {contact.deletedAt && (
        <div className="flex flex-wrap items-center gap-3 rounded border border-warning/40 bg-surface p-3 text-sm">
          <span className="text-foreground">
            {contact.mergedIntoId ? t("This contact was merged into another one.") : t("This contact was deleted.")}
          </span>
          {contact.mergedIntoId ? (
            <Link href={`/leads/contacts/${contact.mergedIntoId}`} className="text-foreground underline">
              {t("Open the merged contact")}
            </Link>
          ) : (
            isAdmin && (
              <button type="button" disabled={busy} onClick={() => void post({ action: "restore" })} className={buttonClass}>
                {t("Restore")}
              </button>
            )
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-1">
          <Card title={t("Details")}>
            <div className="space-y-3 text-sm">
              {contact.company && <p className="text-foreground">{contact.company}</p>}
              <label className="block text-xs text-muted">
                {t("Owner")}
                <select
                  value={contact.ownerUserId ?? ""}
                  disabled={busy}
                  onChange={(e) => void patch({ ownerUserId: e.target.value || null })}
                  className={`${inputClass} mt-1 w-full`}
                >
                  <option value="">{t("Nobody")}</option>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-xs text-muted">
                {t("Stage")}
                <select
                  value={contact.stageKey}
                  disabled={busy}
                  onChange={(e) => void patch({ stageKey: e.target.value })}
                  className={`${inputClass} mt-1 w-full`}
                >
                  {!stages.some((s) => s.key === contact.stageKey) && (
                    <option value={contact.stageKey}>{stageName(contact.stageKey)}</option>
                  )}
                  {stages.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-xs text-muted">
                {t("Lead score")}
                <input
                  key={`${contact.version}-${contact.leadScore}`}
                  type="number"
                  min={0}
                  max={100}
                  defaultValue={contact.leadScore ?? ""}
                  disabled={busy}
                  onBlur={(e) => {
                    const value = e.target.value === "" ? null : Number(e.target.value);
                    if (value !== contact.leadScore && (value === null || (Number.isInteger(value) && value >= 0 && value <= 100)))
                      void patch({ leadScore: value });
                  }}
                  className={`${inputClass} mt-1 w-full`}
                />
              </label>
              {contact.source && (
                <p className="text-xs text-muted">{t("Source: {source}", { source: labels.channel(contact.source) })}</p>
              )}
              <p className="text-xs text-muted">{t("Added {time}", { time: formatDateTime(contact.createdAt, locale) })}</p>
            </div>
          </Card>

          <Card title={t("Identities")}>
            {contact.identities.length === 0 ? (
              <p className="text-sm text-muted">{t("None")}</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {contact.identities.map((i) => (
                  <li key={i.id} className="flex items-center gap-2">
                    <Badge>{humanize(i.kind)}</Badge>
                    <span className="min-w-0 truncate text-foreground">{i.value}</span>
                    {i.verified && <span className="text-xs text-success">{t("Verified")}</span>}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title={t("Consent")}>
            <ul className="divide-y divide-border">
              {CONSENT_CHANNELS.map((channel) => {
                const consent = latestConsent(channel);
                const granted = consent?.status === "GRANTED";
                return (
                  <li key={channel} className="flex items-center gap-2 py-2 text-sm">
                    <span className="flex-1 text-foreground">{t(CONSENT_LABEL[channel])}</span>
                    <span className={`text-xs ${granted ? "text-success" : consent ? "text-error" : "text-muted"}`}>
                      {granted ? t("Granted") : consent ? t("Withdrawn") : t("Not recorded")}
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void post({ action: "consent", channel, status: granted ? "WITHDRAWN" : "GRANTED" })}
                      className="rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-surface-hover disabled:opacity-50"
                    >
                      {granted ? t("Withdraw") : t("Grant")}
                    </button>
                  </li>
                );
              })}
            </ul>
          </Card>

          {contact.duplicates.length > 0 && (
            <Card title={t("Possible duplicates")}>
              <ul className="space-y-3">
                {contact.duplicates.map((d) => {
                  const otherId = d.contactId === contact.id ? d.otherContactId : d.contactId;
                  return (
                    <li key={d.id} className="text-sm">
                      <Link href={`/leads/contacts/${otherId}`} className="text-foreground underline">
                        {t("Open other contact")}
                      </Link>
                      <p className="text-xs text-muted">
                        {d.reason} · {t("Match {percent}%", { percent: Math.round(d.score * 100) })}
                      </p>
                      <div className="mt-1 flex gap-2">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            if (window.confirm(t("Merge the other contact into this one?")))
                              void post({ action: "merge", otherContactId: otherId });
                          }}
                          className={buttonClass}
                        >
                          {t("Merge")}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void run(() => api(`/api/leads/duplicates/${d.id}`, { method: "DELETE" }))}
                          className={buttonClass}
                        >
                          {t("Not the same")}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}
        </div>

        <div className="space-y-4 lg:col-span-2">
          <Card title={t("Conversations")}>
            {contact.conversations.length === 0 ? (
              <p className="text-sm text-muted">{t("No conversations yet.")}</p>
            ) : (
              <ul className="divide-y divide-border">
                {contact.conversations.map((c) => (
                  <li key={c.id}>
                    <Link href={`/leads?c=${c.id}`} className="flex items-center gap-2 py-2 hover:bg-surface-hover">
                      <ChannelBadge channel={c.channel} />
                      <span className="min-w-0 flex-1 truncate text-sm text-foreground">{c.subject ?? labels.channel(c.channel)}</span>
                      <span className="text-xs text-muted">{c.status === "CLOSED" ? t("Closed") : c.status === "SNOOZED" ? t("Snoozed") : t("Open")}</span>
                      <span className="text-xs text-muted">{formatDateTime(c.updatedAt, locale)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title={t("Deals")}>
            {contact.opportunities.length === 0 ? (
              <p className="text-sm text-muted">{t("No deals.")}</p>
            ) : (
              <ul className="divide-y divide-border">
                {contact.opportunities.map((o) => (
                  <li key={o.id} className="flex items-center gap-2 py-2 text-sm">
                    <span className="min-w-0 flex-1 truncate text-foreground">{o.title}</span>
                    <Badge>{stageName(o.stageKey)}</Badge>
                    <span className="text-xs text-muted">{formatMoney(o.valueCents, o.currency, locale)}</span>
                  </li>
                ))}
              </ul>
            )}
            <Link href="/leads/pipeline" className="mt-2 inline-block text-xs text-muted hover:text-foreground hover:underline">
              {t("Open pipeline")}
            </Link>
          </Card>

          <Card title={t("Tasks")}>
            {contact.tasks.length > 0 && (
              <ul className="mb-2 divide-y divide-border">
                {contact.tasks.map((task) => (
                  <TaskRow key={task.id} task={task} now={now} showContact={false} onChanged={() => void load()} />
                ))}
              </ul>
            )}
            <QuickAddTask contactId={contact.id} onCreated={() => void load()} />
          </Card>

          <Card title={t("Timeline")}>
            {contact.timeline.length === 0 ? (
              <p className="text-sm text-muted">{t("Nothing yet.")}</p>
            ) : (
              <ol className="space-y-2">
                {[...contact.timeline]
                  .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
                  .map((e) => {
                    const actor = e.actorKind === "USER" ? members.find((m) => m.id === e.actorId)?.name : null;
                    return (
                      <li key={e.id} className="border-l-2 border-border pl-3">
                        <p className="text-sm text-foreground">
                          {Object.hasOwn(EVENT_LABEL, e.type) ? t(EVENT_LABEL[e.type]) : humanize(e.type)}
                        </p>
                        <p className="text-xs text-muted">
                          {formatDateTime(e.occurredAt, locale)} ·{" "}
                          {actor ?? (Object.hasOwn(ACTOR_LABEL, e.actorKind) ? t(ACTOR_LABEL[e.actorKind]) : e.actorKind)}
                        </p>
                        {e.payload != null && typeof e.payload === "object" && Object.keys(e.payload).length > 0 && (
                          <details className="text-xs text-muted">
                            <summary className="cursor-pointer hover:text-foreground">{t("Details")}</summary>
                            <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all rounded bg-surface p-2 font-mono text-[11px]">
                              {JSON.stringify(e.payload, null, 2)}
                            </pre>
                          </details>
                        )}
                      </li>
                    );
                  })}
              </ol>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
