# Lead model: canonical records and events

Owner: the "Unified lead inbox" thread. Code: `albertaindoorcomfort/openreply`, branch `claude/relay-openreply-ek2wux`, Prisma schema `prisma/schema.prisma` (section "Lead operations"). This file is the contract other modules build against. Version 1, 2026-10-20.

## Rules

1. **One canonical record per thing.** Contacts, conversations, messages, tasks, opportunities and pipeline stages live only here. Other modules (RingCentral, Outlook/Graph, Meetings, Compass, Campaign Canon, Apollo) keep their own external ids and link to these records. They never keep a second copy of a contact.
2. **Every change writes a timeline event** in the same transaction. The timeline is the audit history and the source for reporting.
3. **Tenant = workspace.** Every row carries `workspaceId`. A service key belongs to one workspace, and the workspace always comes from the key, never from the request body.
4. **Writes from adapters are idempotent.** Inbound messages are unique on `(conversationId, externalMessageId)`; conversations on `(workspaceId, channel, externalThreadId)`; identities on `(workspaceId, kind, value)`.
5. **Updates use optimistic concurrency.** Contacts, conversations, tasks and opportunities carry `version`. A write names the version it read; a mismatch returns `409 VERSION_CONFLICT`.
6. **Deletes are soft.** `deletedAt` hides a record; restore clears it. Merges set `mergedIntoId` and keep the merged record.
7. **Customer-facing sends need a human approval** (supervised mode). Internal work (classify, summarise, draft, create tasks) does not.

Cross-module references use URNs: `aic:<kind>:<id>`, for example `aic:contact:clx123`. Apollo task ids (`tsk_…`) and campaign ids (`cmp_…`) are stored as given.

## Records

| Record | Key fields | Notes |
|---|---|---|
| **Contact** | displayName, firstName, lastName, company, primaryEmail, primaryPhone, ownerUserId, stageKey, leadScore, source, sourceDetail, campaignRef, mergedIntoId, deletedAt, version | The lead. `stageKey` is its lifecycle stage. |
| **ContactIdentity** | contactId, kind (`EMAIL`, `PHONE`, `INSTAGRAM`, `MESSENGER`, `WEB_VISITOR`, `EXTERNAL`), value, verified, source | Unique per workspace + kind + value. Emails lower-cased; phones E.164; social ids as the platform gives them. This is the identity-resolution key. |
| **Consent** | contactId, channel (`EMAIL`, `SMS`, `CALL`, `DM`), basis (`EXPRESS`, `IMPLIED`), status (`GRANTED`, `WITHDRAWN`), source, evidence, capturedAt, expiresAt, withdrawnAt | CASL: implied consent from an inquiry expires after 6 months, from a purchase after 2 years. Sends check the latest record per channel. |
| **Conversation** | contactId, channel (`WEB_FORM`, `EMAIL`, `INSTAGRAM`, `MESSENGER`, `SMS`, `CALL`, `VOICEMAIL`, `CHAT`), channelAccountRef, externalThreadId, subject, status (`OPEN`, `SNOOZED`, `CLOSED`), mode, ownerUserId, assignedAgentId, lockUserId, lockExpiresAt, lastInboundAt, lastOutboundAt, replyWindowEndsAt, unreadCount, version | `mode`: `SUPERVISED` (AIC OS drafts, a human approves), `HUMAN` (AIC OS paused, a person has taken over), `MANUAL_ONLY`, `AUTONOMOUS` (reserved, off at launch). |
| **Message** | conversationId, contactId, direction (`INBOUND`, `OUTBOUND`, `INTERNAL`), kind (`MESSAGE`, `NOTE`, `COACHING`, `TRANSCRIPT`, `VOICEMAIL`, `SYSTEM`), authorKind (`CONTACT`, `USER`, `AGENT`, `SYSTEM`), authorId, body, attachments, externalMessageId, occurredAt, deliveryStatus | `INTERNAL` messages (notes, coaching to AIC OS) are never sent to a customer and never shown on a customer channel. |
| **Draft** | conversationId, body, bodySha256, authorKind, authorId, rationale, evidence, confidence, basedOnMessageId, status (`PROPOSED`, `SENDING`, `SENT`, `FAILED`, `SEND_UNCONFIRMED`, `DISCARDED`, `STALE`), approvalId, idempotencyKey | A send is refused as `STALE` if a newer inbound or any outbound arrived after `basedOnMessageId`. `approvalId` and `idempotencyKey` are unique, so one approval or one click sends once. |
| **Task** | title, notes, dueAt, remindAt, status (`OPEN`, `DONE`, `CANCELLED`), priority, contactId, conversationId, opportunityId, assigneeUserId, assigneeAgentId, createdByKind, createdById, completedAt, deletedAt, version | Follow-ups and reminders. |
| **Pipeline / PipelineStage** | name; stage key, name, position, kind (`OPEN`, `WON`, `LOST`) | Per workspace. Default stages: `new`, `qualifying`, `nurturing`, `appointment`, `estimate`, `negotiation`, `won`, `lost`, `reactivation`. |
| **Opportunity** | contactId, pipelineId, stageKey, title, valueCents, currency, ownerUserId, expectedCloseAt, outcome (`OPEN`, `WON`, `LOST`), lostReason, campaignRef, closedAt, deletedAt, version | Deal value and conversion outcome. |
| **Assessment** | conversationId, contactId, intent, urgency (`LOW`, `NORMAL`, `HIGH`, `EMERGENCY`), sentiment, leadScore, summary, nextActions, evidence, producer, confidence, supersededAt | AIC OS's classify, summarise and next-action output. Each assessment is kept; the newest unsuperseded one is current. |
| **Feedback** | targetKind (`ASSESSMENT`, `DRAFT`, `RECOMMENDATION`, `SUMMARY`, `ROUTING`, `MEETING_NOTE`), targetId, original, corrected, reason, userId, conversationId, status (`NEW`, `TRIAGED`, `IN_EVAL`, `ADOPTED`, `REJECTED`) | Human corrections. Inputs to evaluation, never applied to production prompts or policy automatically. |
| **DuplicateCandidate** | contactId, otherContactId, reason, score, status (`OPEN`, `MERGED`, `DISMISSED`) | Raised when one inbound matches identities on two contacts, or by name+phone/email similarity. |
| **TimelineEvent** | type, actorKind, actorId, contactId, conversationId, opportunityId, taskId, payload, occurredAt | Append-only. See event types below. |

Meetings (owned by the Meetings thread) link with `contactId`, `opportunityId` and write `meeting.*` timeline events through the API below. RingCentral (voice thread) posts calls, SMS and voicemail as normalised channel events.

## Event types

`contact.created`, `contact.updated`, `contact.merged`, `contact.deleted`, `contact.restored`, `identity.linked`, `consent.recorded`, `consent.withdrawn`,
`conversation.created`, `conversation.assigned`, `conversation.mode_changed` (takeover / resume), `conversation.closed`, `conversation.reopened`,
`message.received`, `message.sent`, `message.send_failed`, `message.send_unconfirmed`, `note.added`, `coaching.added`,
`draft.proposed`, `draft.approved`, `draft.discarded`, `draft.stale`,
`assessment.created`, `feedback.recorded`,
`task.created`, `task.updated`, `task.completed`,
`opportunity.created`, `opportunity.stage_changed`, `opportunity.won`, `opportunity.lost`,
`duplicate.flagged`,
`meeting.scheduled`, `meeting.rescheduled`, `meeting.completed`, `meeting.notes_linked` (written by Meetings),
`call.completed`, `voicemail.received` (written by RingCentral).

## Adapter API (service keys)

Base path `/api/relay/v1`. Agent calls (`assist:write`) may name the agent in `x-agent-id` (default `carla`). Auth: `Authorization: Bearer orly_<prefix>_<secret>`, a workspace-scoped key with scopes. Keys are minted with `npm run relay:key -- --workspace <id> --name <name> --scopes ...`.

| Method and path | Scope | Purpose |
|---|---|---|
| `POST /events` | `events:ingest` | Normalised inbound message from any channel. Resolves or creates the contact, conversation and message. Idempotent. |
| `POST /timeline` | `timeline:write` | Write a `meeting.*`, `call.*` or `voicemail.*` event linked to a contact or opportunity. |
| `GET /contacts?q=`, `GET /contacts/:id` | `inbox:read` | Lookup and full profile (identities, consent, conversations, tasks, opportunities, latest assessment). |
| `GET /conversations?status=&mode=`, `GET /conversations/:id` | `inbox:read` | Inbox and thread with messages. |
| `POST /conversations/:id/assist` | `assist:write` | Run AIC OS now: classification, summary, next actions, tasks, draft. |
| `POST /conversations/:id/drafts` | `assist:write` | AIC OS's proposed reply. Never sends. An `idempotency-key` header (8 to 100 of `A-Za-z0-9_:.-`) makes a retry return the first draft. |
| `POST /feedback` | `feedback:write` | Forwards a person's correction: `{targetKind, targetId, corrected, original?, reason?, conversationId?, contactId?, correctedBy}`. `targetKind` is `ASSESSMENT`, `DRAFT`, `RECOMMENDATION`, `SUMMARY`, `ROUTING` or `MEETING_NOTE`; `correctedBy` must be a member of the key's workspace. An `idempotency-key` header stores a retry once. Returns `{feedbackId, status}`. Feedback never changes AIC OS's instructions. |
| `POST /drafts/:id/send` | `messages:send` | Sends one approved draft. Needs a send grant (below). |
| `POST /conversations/:id/handoff` | `assist:write` | AIC OS asks for a human: sets mode `HUMAN`, raises a task. |
| `POST /tasks`, `PATCH /tasks/:id` | `tasks:write` | Tasks and reminders. |
| `GET /changes?after=<cursor>` | `inbox:read` | Timeline feed for Apollo, Trigr and Compass. |

### Normalised inbound event (`POST /events`)

```json
{
  "channel": "EMAIL",
  "channelAccountRef": "service@aic.example",
  "externalThreadId": "AAQkAGI2...",
  "externalMessageId": "<CAF123@mail.example>",
  "occurredAt": "2026-10-20T17:30:00Z",
  "from": {
    "displayName": "Jordan Lee",
    "identities": [{ "kind": "EMAIL", "value": "jordan@example.com" }, { "kind": "PHONE", "value": "+14035550100" }]
  },
  "subject": "Furnace not starting",
  "body": "Hi, our furnace stopped working last night...",
  "attachments": [],
  "consent": { "channel": "EMAIL", "basis": "IMPLIED", "source": "inbound inquiry" },
  "source": { "campaignRef": "cmp_...", "detail": "google-ads" }
}
```

### Send grants

Sending is the one effect that leaves AIC. Apollo records the approval (`comms:send`), consumes it, then signs a grant with the shared `RELAY_GRANT_SECRET` (HMAC-SHA256). The grant names `approvalId`, `workspaceId`, `draftId`, `textSha256`, `approvedBy`, `iat`, `exp` (at most 10 minutes). Relay checks the signature and every field against the draft, stores `approvalId` under a unique index, refuses stale drafts, refuses a conversation in `HUMAN` mode, and checks consent and the channel's reply window. Reference implementation: `lib/relay/grant.ts`, dependency-free so Apollo can reuse it.

Humans sending from the inbox UI use their session, a client-generated `idempotencyKey`, and the same stale and lock checks.

## Human takeover and collision rules

- **Take over** sets mode `HUMAN`, owner = that user, cancels AIC OS's open drafts (`DISCARDED`) and writes `conversation.mode_changed`. AIC OS cannot send in `HUMAN` mode, even with a grant.
- **Resume** sets mode back to `SUPERVISED`.
- **Compose lock**: opening the composer takes a 2-minute lock (`lockUserId`, `lockExpiresAt`), renewed while typing. Another person sees who is replying; a send by someone without the lock is refused with `409 LOCKED`.
- **Coaching**: a `COACHING` message is internal, attached to the conversation, and is included in AIC OS's next drafting context. It is never sent.

## Website forms

`POST /api/forms/<form key>` accepts JSON or a plain HTML form post: `name` (or `firstName`, `lastName`), `email`, `phone`, `company`, `message`, `subject`, `consent` (`on` when a marketing opt-in box is ticked), `page`, `utm_source`, `utm_medium`, `utm_campaign`, `campaign_ref`, `submission_id`, and a hidden honeypot field `website` that must stay empty. A form key holds only `forms:submit`, so it is safe in page source. 10 posts per IP per minute. `?redirect=` is honoured only for hosts in `LEADS_FORM_REDIRECT_HOSTS`.

`POST /api/forms/google-ads` is the webhook for Google Ads lead forms. In the form's webhook settings, the URL is this route and the key is a `forms:submit` key; Google sends it as `google_key` in the body, so the URL holds no secret. Contact columns become the contact, other answers become the message, and the form, campaign, ad group and click id become the source detail. Google's test leads (`is_test`) check the key and store nothing. A retry of the same `lead_id` is stored once. Wrong keys get 401, and a stored lead gets 200, which is the only answer Google treats as delivered.

## Staff API (signed-in users)

`/api/leads/*` serves the inbox UI with the same rules: `today`, `conversations` (+ `/:id`, `/:id/actions` for takeover, resume, lock, assign, note, coach, assist, close, `/:id/send`), `drafts/:id` (discard), `contacts` (+ merge, restore, consent), `duplicates/:id`, `board`, `opportunities/:id`, `tasks`, `feedback`, `knowledge`, `members`. Writes require a same-origin request.

## Status of v1 (2026-10-20)

Built and tested in openreply#2: everything above, plus the website form, Instagram DM bridge, SMTP email sender and the voice-service SMS sender. Outlook mail sending comes from the Meetings thread (`registerSender("EMAIL", …)`).
