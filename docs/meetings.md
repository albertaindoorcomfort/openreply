# Meetings and Outlook calendar

Carla's meeting workspace: **Today**, **Calendar**, **Meetings** and **Notes**,
on top of Microsoft 365 through Microsoft Graph. It books and moves Outlook
meetings after checking free/busy, prepares briefs, keeps consented notes,
summarizes, turns action items into lead tasks, and prepares follow-up drafts.
It never sends a message to a customer by itself.

## How it fits

| Owns | Links to (owned by the lead inbox) |
|---|---|
| Microsoft connection, Graph client, webhooks | Contacts, conversations, tasks, opportunities |
| Meetings (mirrors of Outlook events), notes, consent, briefs, summaries, follow-ups | Timeline (`meeting.*` events), drafts |

Meetings store `contactId`, `opportunityId` and `conversationId` from the lead
model and call its adapter API (`/api/relay/v1`). Every meeting change is
written to a local history in the same transaction, and `meeting.scheduled`,
`meeting.rescheduled`, `meeting.completed` and `meeting.notes_linked` are pushed
to the lead timeline by an outbox once the meeting is linked to a lead. The
event id is the idempotency key, so retries never duplicate an entry.

## Microsoft 365 setup

1. In Entra ID, register a web app. Redirect URI:
   `https://<host>/api/microsoft/callback`. Create a client secret.
2. Add delegated Microsoft Graph permissions: `User.Read`,
   `Calendars.ReadWrite`, `Mail.ReadWrite`, `Mail.Send`, `Contacts.Read`,
   `OnlineMeetings.Read`, `offline_access`, `openid`, `profile`, `email`.
   For Teams transcripts also add `OnlineMeetingTranscript.Read.All` and grant
   admin consent.
3. Set `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` and `MICROSOFT_TENANT`
   (the directory id; it pins sign-in to that tenant). `ENCRYPTION_KEY` and
   `NEXTAUTH_SECRET` are reused.
4. Graph must reach `/api/microsoft/notifications` and
   `/api/microsoft/lifecycle` over public HTTPS.
5. Call `GET /api/cron/meetings` with `Authorization: Bearer $CRON_SECRET`
   every 15 minutes. It renews subscriptions, retries failed notifications,
   reconciles calendars, marks ended meetings, pushes timeline events and
   applies transcript retention. The `vercel.json` entry is daily, the
   minimum that keeps subscriptions alive.

Each user connects their own mailbox from **Meetings › Microsoft 365**. Tokens
are AES-256-GCM encrypted at rest and refreshed on use; a revoked or expired
grant marks the connection `NEEDS_REAUTH` and stops background calls for it.

## What Graph does and does not provide

Checked against the Graph v1.0 documentation:

- Calendar events carry Teams metadata only (`isOnlineMeeting`, join URL).
  They never include recordings or transcripts.
- Transcripts come from `/me/onlineMeetings/{id}/transcripts` as WebVTT with
  speaker names. They need `OnlineMeetingTranscript.Read.All` (admin consent),
  exist only if transcription was turned on in Teams, and are readable only by
  the meeting organizer with delegated access.
- Recordings need `OnlineMeetingRecording.Read.All`. We do not request it:
  notes need the transcript, not audio.
- Phone, on-site and non-Teams meetings have nothing to fetch.

Every case where no transcript can be read shows the reason and falls back to
typed notes. Importing a transcript also requires a recorded transcription
consent for that meeting; a later "declined or withdrawn" blocks further
imports. Transcripts are deleted after `transcriptRetentionDays` (365 by
default); typed notes are kept.

## Rules the code enforces

- **Availability first.** Booking and moving read Outlook free/busy for the
  organizer and every internal attendee right before writing. If a calendar
  cannot be read, nothing is booked. Pending AIC bookings also hold their slot.
- **Approval for anything a customer receives.** An invite, update or
  cancellation to an address outside `AIC_INTERNAL_DOMAINS` needs a person
  clicking the button, or an Apollo approval id when Carla asks.
- **No duplicate events.** The meeting id is Graph's `transactionId`; a booking
  whose response was lost is claimed by the next sync.
- **No silent overwrites.** Moves send `If-Match` with the last `changeKey`; an
  edit made in Outlook meanwhile wins and is shown. Meetings and notes carry a
  version for edits made here.
- **Idempotent webhooks.** Notifications are verified by `clientState`, stored,
  acknowledged with 202 and processed after the response. Duplicates collapse;
  failures back off and retry; after 8 attempts a notification is dead and a
  full delta sync reconciles. Lifecycle events renew, recreate or resync.
- **Corrections are feedback.** A corrected summary supersedes Carla's and is
  recorded with the original, then forwarded to the lead inbox feedback queue
  (`POST /feedback`, `feedback:write` scope) for evaluation. Nothing changes
  Carla's prompts.
- **Follow-ups are drafts.** With an email conversation for the lead, the
  follow-up becomes a draft in the inbox (sent only after approval). Without
  one it is saved to the organizer's Outlook Drafts.

## Apollo tools

`POST /aic/tools/{tool}` per contracts.md section 3 (HMAC signature,
5-minute window, `idempotency-key`). Tenants map to workspaces through
`AIC_TENANT_WORKSPACES`.

| Tool | Does | Apollo permission |
|---|---|---|
| `meetings.check_availability` | Free/busy and alternatives | `calendar:read` |
| `meetings.upcoming` | Upcoming meetings for a mailbox | `calendar:read` |
| `meetings.book` | Books after a fresh availability check | `calendar:write`, always approved |
| `meetings.reschedule` | Moves with If-Match; a retried move returns success | `calendar:write`, always approved |
| `meetings.brief` | Prep brief with evidence | `meeting:read` |
| `meetings.summarize` | Summary, decisions, action items | `meeting:write` |
| `meetings.create_action_tasks` | Lead tasks with reminders | `workflow:create` |
| `meetings.prepare_follow_up` | Inbox or Outlook draft, never a send | `comms:draft` |

## Tests

`__tests__/meetings.test.ts` (no database) and `__tests__/meetings.db.test.ts`
(real Postgres, Graph and Relay faked at their HTTP/API edge) cover calendar
conflicts, unreadable calendars, idempotent booking, lost Graph responses,
concurrent Outlook edits, forged/duplicate/failed/dead notifications,
lifecycle events, subscription renewal and revocation, transcript consent and
permission denial, tenant isolation, task and follow-up idempotency, and the
timeline outbox. CI runs both against a Postgres service.
