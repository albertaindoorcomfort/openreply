import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { canManageWorkspace } from "@/lib/workspace-access";
import { actionItemSchema } from "@/lib/meetings/assistant";
import { readAttendees } from "@/lib/meetings/events";
import { formatDay, formatTime, utcToLocalInput } from "@/lib/meetings/time";
import {
  addNoteAction,
  briefAction,
  cancelAction,
  consentAction,
  correctSummaryAction,
  deleteNoteAction,
  editNoteAction,
  followUpAction,
  linkAction,
  rescheduleAction,
  summarizeAction,
  tasksAction,
  transcriptAction,
} from "../../actions";
import ActionForm from "../../_components/action-form";
import { pageContext, STATUS_STYLE } from "../../_components/data";

const field = "w-full rounded border border-border bg-background px-2 py-1.5 text-sm";
const card = "rounded border border-border p-4";

export default async function MeetingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx } = await pageContext();
  const meeting = await prisma.meeting.findFirst({
    where: { id, workspaceId: ctx.workspaceId, deletedAt: null },
    include: {
      connection: { select: { userId: true, email: true } },
      notes: { orderBy: { createdAt: "asc" } },
      consents: { orderBy: { capturedAt: "desc" }, take: 1 },
      briefs: { orderBy: { createdAt: "desc" }, take: 1 },
      summaries: { where: { supersededAt: null }, orderBy: { createdAt: "desc" }, take: 1 },
      followUps: { orderBy: { createdAt: "desc" }, take: 1 },
      events: { orderBy: { occurredAt: "desc" }, take: 30 },
    },
  });
  if (!meeting) notFound();

  const tz = meeting.timezone;
  const canMove = meeting.connection.userId === ctx.userId || canManageWorkspace(ctx.role);
  const attendees = readAttendees(meeting.attendees);
  const consent = meeting.consents[0];
  const brief = meeting.briefs[0];
  const summary = meeting.summaries[0];
  const followUp = meeting.followUps[0];
  const decisions = summary ? z.array(z.string()).catch([]).parse(summary.decisions) : [];
  const items = summary ? z.array(actionItemSchema).catch([]).parse(summary.actionItems) : [];
  const live = meeting.notes.filter((n) => !n.deletedAt);
  const deleted = meeting.notes.filter((n) => n.deletedAt && n.kind === "MANUAL");
  const hidden = <input type="hidden" name="meetingId" value={meeting.id} />;

  return (
    <article>
      <header className="mb-6">
        <Link href="/meetings" className="text-sm text-muted hover:underline">
          ← Meetings
        </Link>
        <h1 className={`mt-1 text-2xl font-semibold ${STATUS_STYLE[meeting.status]}`}>{meeting.title}</h1>
        <p className="text-sm text-muted">
          {formatDay(meeting.startsAt, tz)}, {formatTime(meeting.startsAt, tz)} – {formatTime(meeting.endsAt, tz)}
          {meeting.status !== "SCHEDULED" ? ` · ${meeting.status.toLowerCase()}` : ""}
          {meeting.isOnline ? " · Teams" : meeting.location ? ` · ${meeting.location}` : ""}
        </p>
        <p className="mt-1 text-sm">
          {attendees.map((a) => (
            <span key={a.email} className="mr-2 inline-block">
              {a.name ?? a.email}
              {a.internal ? "" : " ·ext"}
              {a.response && a.response !== "none" ? <span className="text-muted"> ({a.response})</span> : null}
            </span>
          ))}
        </p>
        {meeting.joinUrl && meeting.status === "SCHEDULED" ? (
          <a href={meeting.joinUrl} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-sm underline">
            Join in Teams
          </a>
        ) : null}
      </header>

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-6">
          <section aria-labelledby="notes-h" className={card}>
            <h2 id="notes-h" className="mb-3 font-medium">
              Notes
            </h2>
            {live.map((n) =>
              n.kind === "TRANSCRIPT" ? (
                <details key={n.id} className="mb-3 rounded bg-surface p-3 text-sm">
                  <summary className="cursor-pointer">Teams transcript ({n.body.split("\n").length} lines)</summary>
                  <p className="mt-2 whitespace-pre-wrap">{n.body}</p>
                </details>
              ) : (
                <div key={n.id} className="mb-3 flex flex-wrap items-start gap-2 border-b border-border pb-3">
                  <ActionForm action={editNoteAction} submitLabel="Save" variant="secondary" className="min-w-0 flex-1 basis-full">
                    <input type="hidden" name="noteId" value={n.id} />
                    <input type="hidden" name="version" value={n.version} />
                    <textarea name="body" defaultValue={n.body} rows={Math.min(12, n.body.split("\n").length + 1)} aria-label="Note" className={field} />
                  </ActionForm>
                  <ActionForm action={deleteNoteAction} submitLabel="Delete" variant="danger">
                    <input type="hidden" name="noteId" value={n.id} />
                    <input type="hidden" name="deleted" value="true" />
                  </ActionForm>
                </div>
              )
            )}
            <ActionForm action={addNoteAction} submitLabel="Add note">
              {hidden}
              <textarea
                name="body"
                rows={5}
                required
                placeholder={"What happened. Mark lines with Action: or Decision: and Carla picks them up."}
                aria-label="New note"
                className={field}
              />
            </ActionForm>
            {deleted.length ? (
              <details className="mt-3 text-sm">
                <summary className="cursor-pointer text-muted">Deleted notes ({deleted.length})</summary>
                {deleted.map((n) => (
                  <div key={n.id} className="mt-2 rounded bg-surface p-2">
                    <p className="mb-1 line-clamp-3 whitespace-pre-wrap text-muted">{n.body}</p>
                    <ActionForm action={deleteNoteAction} submitLabel="Restore" variant="secondary">
                      <input type="hidden" name="noteId" value={n.id} />
                      <input type="hidden" name="deleted" value="false" />
                    </ActionForm>
                  </div>
                ))}
              </details>
            ) : null}
          </section>

          <section aria-labelledby="consent-h" className={card}>
            <h2 id="consent-h" className="mb-1 font-medium">
              Transcription
            </h2>
            <p className="mb-3 text-sm text-muted">
              {consent
                ? `Consent ${consent.status.toLowerCase()} (${consent.method.toLowerCase()}) on ${formatDay(consent.capturedAt, tz)}.`
                : "No consent recorded. Read the disclosure to attendees before importing a transcript."}
            </p>
            <ActionForm action={consentAction} submitLabel="Record" variant="secondary">
              {hidden}
              <fieldset className="flex flex-wrap gap-3 text-sm">
                <legend className="sr-only">Decision</legend>
                <label className="flex items-center gap-1">
                  <input type="radio" name="decision" value="granted" required /> Attendees agreed
                </label>
                <label className="flex items-center gap-1">
                  <input type="radio" name="decision" value="declined" /> Declined or withdrawn
                </label>
              </fieldset>
              <select name="method" aria-label="How consent was given" className={field} defaultValue="VERBAL">
                <option value="VERBAL">Said out loud</option>
                <option value="WRITTEN">In writing</option>
                <option value="TEAMS_BANNER">Teams transcription notice</option>
              </select>
              <input name="participants" placeholder="Who agreed (emails)" aria-label="Who agreed" className={field} />
            </ActionForm>
            {meeting.isOnline ? (
              <ActionForm action={transcriptAction} submitLabel="Import Teams transcript" pendingLabel="Fetching…" variant="secondary" className="mt-3">
                {hidden}
              </ActionForm>
            ) : (
              <p className="mt-3 text-sm text-muted">Not a Teams meeting, so there is no transcript to import.</p>
            )}
          </section>

          <section aria-labelledby="summary-h" className={card}>
            <h2 id="summary-h" className="mb-3 font-medium">
              Summary and next steps
            </h2>
            {summary ? (
              <div className="mb-4 space-y-3 text-sm">
                <p className="whitespace-pre-wrap">{summary.summary}</p>
                {decisions.length ? (
                  <div>
                    <h3 className="font-medium">Decisions</h3>
                    <ul className="list-disc pl-5">
                      {decisions.map((d, i) => (
                        <li key={i}>{d}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {items.length ? (
                  <div>
                    <h3 className="font-medium">Action items</h3>
                    <ul className="list-disc pl-5">
                      {items.map((a, i) => (
                        <li key={i}>
                          {a.title}
                          {a.owner ? <span className="text-muted"> · {a.owner}</span> : null}
                          {a.relayTaskId ? <span className="text-success"> · task created</span> : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <p className="text-xs text-muted">
                  {summary.authorKind === "USER" ? "Corrected by a person" : summary.producer === "heuristic" ? "Drafted from marked lines" : "Drafted by Carla"}
                </p>
                <details>
                  <summary className="cursor-pointer text-sm">Correct this summary</summary>
                  <ActionForm action={correctSummaryAction} submitLabel="Save correction" className="mt-2">
                    <input type="hidden" name="summaryId" value={summary.id} />
                    <textarea name="summary" defaultValue={summary.summary} rows={4} aria-label="Summary" className={field} />
                    <textarea name="decisions" defaultValue={decisions.join("\n")} rows={3} aria-label="Decisions, one per line" placeholder="Decisions, one per line" className={field} />
                    <textarea name="actionItems" defaultValue={items.map((a) => a.title).join("\n")} rows={3} aria-label="Action items, one per line" placeholder="Action items, one per line" className={field} />
                    <input name="reason" placeholder="What was wrong (helps Carla improve)" aria-label="Reason" className={field} />
                  </ActionForm>
                </details>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <ActionForm action={summarizeAction} submitLabel={summary ? "Summarize again" : "Summarize notes"} pendingLabel="Summarizing…" variant="secondary">
                {hidden}
              </ActionForm>
              {items.length ? (
                <ActionForm action={tasksAction} submitLabel="Create tasks" variant="secondary">
                  {hidden}
                </ActionForm>
              ) : null}
              {summary ? (
                <ActionForm action={followUpAction} submitLabel="Prepare follow-up" variant="secondary">
                  {hidden}
                </ActionForm>
              ) : null}
            </div>
            {followUp ? (
              <div className="mt-4 rounded bg-surface p-3 text-sm">
                <p className="mb-1 text-xs text-muted">
                  Follow-up ·{" "}
                  {followUp.status === "RELAY_DRAFT" ? "in the lead's inbox, awaiting approval" : followUp.status === "OUTLOOK_DRAFT" ? "in your Outlook Drafts" : "not sent"}
                </p>
                <p className="whitespace-pre-wrap">{followUp.body}</p>
              </div>
            ) : null}
          </section>
        </div>

        <aside className="space-y-6">
          <section aria-labelledby="brief-h" className={card}>
            <h2 id="brief-h" className="mb-2 font-medium">
              Prep brief
            </h2>
            {brief ? (
              <>
                <p className="mb-2 whitespace-pre-wrap text-sm">{brief.body}</p>
                <p className="mb-2 text-xs text-muted">
                  {formatDay(brief.createdAt, tz)} {formatTime(brief.createdAt, tz)} · {Array.isArray(brief.evidence) ? brief.evidence.length : 0} sources
                </p>
              </>
            ) : (
              <p className="mb-2 text-sm text-muted">Carla gathers the lead, open tasks, deals, past meetings and recent email.</p>
            )}
            <ActionForm action={briefAction} submitLabel={brief ? "Refresh brief" : "Prepare brief"} pendingLabel="Preparing…" variant="secondary">
              {hidden}
            </ActionForm>
          </section>

          <section aria-labelledby="lead-h" className={card}>
            <h2 id="lead-h" className="mb-2 font-medium">
              Lead
            </h2>
            {meeting.contactId ? (
              <p className="mb-2 text-sm">
                <Link href={`/inbox?contact=${encodeURIComponent(meeting.contactId)}`} className="underline">
                  Open lead in the inbox
                </Link>
              </p>
            ) : (
              <p className="mb-2 text-sm text-muted">Not linked. Link a lead so notes and outcomes reach its timeline.</p>
            )}
            <ActionForm action={linkAction} submitLabel="Save link" variant="secondary">
              {hidden}
              <input type="hidden" name="version" value={meeting.version} />
              <input name="contactId" defaultValue={meeting.contactId ?? ""} placeholder="Contact id" aria-label="Contact id" className={field} />
              <input name="opportunityId" defaultValue={meeting.opportunityId ?? ""} placeholder="Opportunity id" aria-label="Opportunity id" className={field} />
            </ActionForm>
          </section>

          {canMove && meeting.status === "SCHEDULED" && meeting.graphEventId ? (
            <section aria-labelledby="move-h" className={card}>
              <h2 id="move-h" className="mb-2 font-medium">
                Reschedule
              </h2>
              <ActionForm action={rescheduleAction} submitLabel="Check and move" pendingLabel="Checking calendars…">
                {hidden}
                <input type="hidden" name="version" value={meeting.version} />
                <input name="start" type="datetime-local" required defaultValue={utcToLocalInput(meeting.startsAt, tz)} aria-label={`New start (${tz})`} className={field} />
              </ActionForm>
              <details className="mt-3 text-sm">
                <summary className="cursor-pointer text-error">Cancel meeting</summary>
                <ActionForm action={cancelAction} submitLabel="Cancel and notify attendees" variant="danger" className="mt-2">
                  {hidden}
                  <input type="hidden" name="version" value={meeting.version} />
                  <textarea name="comment" rows={2} placeholder="Message to attendees" aria-label="Message to attendees" className={field} />
                </ActionForm>
              </details>
            </section>
          ) : null}

          <section aria-labelledby="hist-h" className={card}>
            <h2 id="hist-h" className="mb-2 font-medium">
              History
            </h2>
            <ol className="space-y-1 text-xs text-muted">
              {meeting.events.map((e) => (
                <li key={e.id}>
                  {formatDay(e.occurredAt, tz).split(",").slice(1).join(",")} {formatTime(e.occurredAt, tz)} · {e.type.replace("meeting.", "").replaceAll("_", " ")}
                  {e.actorKind === "AGENT" ? " (Carla)" : e.actorKind === "SYSTEM" ? " (sync)" : ""}
                </li>
              ))}
            </ol>
          </section>
        </aside>
      </div>
    </article>
  );
}
