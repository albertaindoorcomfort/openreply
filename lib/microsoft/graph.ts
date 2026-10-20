/**
 * Microsoft Graph v1.0 client for one delegated mailbox.
 *
 * Retries 429, 503 and 504 with Graph's Retry-After (capped), then fails with
 * a GraphError that carries the status and Graph's error code, never the
 * response body (it can hold personal data).
 */

export type Fetch = typeof fetch;

export interface TokenProvider {
  get(): Promise<string>;
}

export class GraphError extends Error {
  constructor(readonly status: number, readonly code: string, readonly path: string) {
    super(`graph ${status} ${code} ${path}`);
  }
  get isPermissionDenied() {
    return this.status === 403 || this.code === "Forbidden" || this.code === "ErrorAccessDenied";
  }
  get isNotFound() {
    return this.status === 404;
  }
  get isPreconditionFailed() {
    return this.status === 412;
  }
}

const GRAPH = "https://graph.microsoft.com/v1.0";
const MAX_RETRIES = 3;
const MAX_RETRY_AFTER_MS = 30_000;

export interface GraphDateTime {
  dateTime: string;
  timeZone: string;
}

export interface GraphAttendee {
  emailAddress: { address: string; name?: string };
  type?: "required" | "optional" | "resource";
  status?: { response?: string };
}

export interface GraphEvent {
  id: string;
  iCalUId?: string;
  changeKey?: string;
  "@odata.etag"?: string;
  "@removed"?: { reason: string };
  subject?: string;
  bodyPreview?: string;
  start?: GraphDateTime;
  end?: GraphDateTime;
  location?: { displayName?: string };
  attendees?: GraphAttendee[];
  organizer?: { emailAddress: { address: string; name?: string } };
  isCancelled?: boolean;
  isOnlineMeeting?: boolean;
  onlineMeetingProvider?: string;
  onlineMeeting?: { joinUrl?: string } | null;
  showAs?: string;
  type?: string;
  transactionId?: string;
}

export interface NewGraphEvent {
  subject: string;
  body: string;
  start: Date;
  end: Date;
  attendees: { email: string; name?: string }[];
  location?: string | null;
  teams: boolean;
  /** Graph drops a repeated POST with the same transactionId. */
  transactionId: string;
}

export interface ScheduleItem {
  status: string;
  start: Date;
  end: Date;
}

export interface GraphSubscriptionResponse {
  id: string;
  expirationDateTime: string;
  resource: string;
}

/** Graph returns UTC wall time without a zone suffix when asked for UTC. */
export function parseGraphDate(value: GraphDateTime | undefined): Date | null {
  if (!value?.dateTime) return null;
  const tz = (value.timeZone ?? "UTC").toUpperCase();
  if (tz !== "UTC" && tz !== "Z") {
    // Callers always send Prefer: outlook.timezone="UTC"; anything else is a bug.
    throw new Error(`unexpected graph timezone ${value.timeZone}`);
  }
  const iso = /[zZ]|[+-]\d\d:\d\d$/.test(value.dateTime) ? value.dateTime : `${value.dateTime}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

const utc = (d: Date): GraphDateTime => ({ dateTime: d.toISOString().replace(/Z$/, ""), timeZone: "UTC" });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class GraphClient {
  constructor(
    private readonly tokens: TokenProvider,
    private readonly f: Fetch = fetch,
    private readonly wait: (ms: number) => Promise<void> = sleep
  ) {}

  async request<T>(path: string, init: RequestInit & { raw?: boolean } = {}): Promise<T> {
    const url = path.startsWith("https://") ? path : `${GRAPH}${path}`;
    if (!url.startsWith(`${GRAPH}/`)) throw new GraphError(0, "bad_url", "external");
    const label = new URL(url).pathname.replace(/\/[A-Za-z0-9_=-]{40,}/g, "/…");

    for (let attempt = 0; ; attempt++) {
      const token = await this.tokens.get();
      const res = await this.f(url, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.body ? { "content-type": "application/json" } : {}),
          Prefer: 'outlook.timezone="UTC"',
          ...init.headers,
        },
        signal: init.signal ?? AbortSignal.timeout(20_000),
      });

      if ((res.status === 429 || res.status === 503 || res.status === 504) && attempt < MAX_RETRIES) {
        const header = Number(res.headers.get("retry-after"));
        const ms = Number.isFinite(header) && header > 0 ? header * 1000 : 2 ** attempt * 1000;
        await this.wait(Math.min(ms, MAX_RETRY_AFTER_MS));
        continue;
      }
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
        throw new GraphError(res.status, json.error?.code ?? "unknown", label);
      }
      if (init.raw) return (await res.text()) as T;
      if (res.status === 202 || res.status === 204) return {} as T;
      const text = await res.text();
      return (text ? JSON.parse(text) : {}) as T;
    }
  }

  me() {
    return this.request<{ id: string; mail?: string; userPrincipalName: string; displayName?: string }>(
      "/me?$select=id,mail,userPrincipalName,displayName"
    );
  }

  mailboxTimezone() {
    return this.request<{ value?: string }>("/me/mailboxSettings/timeZone").then((r) => r.value ?? null);
  }

  // Calendar ---------------------------------------------------------------

  static readonly EVENT_FIELDS =
    "id,iCalUId,changeKey,subject,bodyPreview,start,end,location,attendees,organizer,isCancelled,isOnlineMeeting,onlineMeetingProvider,onlineMeeting,showAs,type,transactionId";

  getEvent(id: string) {
    return this.request<GraphEvent>(`/me/events/${encodeURIComponent(id)}?$select=${GraphClient.EVENT_FIELDS}`);
  }

  /** One page of a calendarView delta round. Pass the start URL or a next/delta link. */
  calendarDeltaPage(link: string) {
    return this.request<{ value: GraphEvent[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string }>(link, {
      headers: { Prefer: 'outlook.timezone="UTC", odata.maxpagesize=50' },
    });
  }

  static calendarDeltaStart(from: Date, to: Date) {
    return `${GRAPH}/me/calendarView/delta?startDateTime=${from.toISOString()}&endDateTime=${to.toISOString()}`;
  }

  createEvent(e: NewGraphEvent) {
    return this.request<GraphEvent>("/me/events", {
      method: "POST",
      body: JSON.stringify({
        subject: e.subject,
        body: { contentType: "Text", content: e.body },
        start: utc(e.start),
        end: utc(e.end),
        location: e.location ? { displayName: e.location } : undefined,
        attendees: e.attendees.map((a) => ({ emailAddress: { address: a.email, name: a.name }, type: "required" })),
        isOnlineMeeting: e.teams,
        onlineMeetingProvider: e.teams ? "teamsForBusiness" : undefined,
        transactionId: e.transactionId,
        allowNewTimeProposals: true,
      }),
    });
  }

  /** Moves an event. If-Match makes a concurrent edit in Outlook fail with 412 instead of being overwritten. */
  rescheduleEvent(id: string, start: Date, end: Date, etag: string | null) {
    return this.request<GraphEvent>(`/me/events/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: etag ? { "If-Match": etag } : {},
      body: JSON.stringify({ start: utc(start), end: utc(end) }),
    });
  }

  cancelEvent(id: string, comment: string) {
    return this.request(`/me/events/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      body: JSON.stringify({ comment }),
    });
  }

  /** Free/busy for mailboxes in the same organization. */
  async getSchedule(emails: string[], from: Date, to: Date): Promise<Map<string, ScheduleItem[] | null>> {
    const r = await this.request<{
      value: { scheduleId: string; error?: { message?: string }; scheduleItems?: { status: string; start: GraphDateTime; end: GraphDateTime }[] }[];
    }>("/me/calendar/getSchedule", {
      method: "POST",
      body: JSON.stringify({ schedules: emails, startTime: utc(from), endTime: utc(to), availabilityViewInterval: 15 }),
    });
    const out = new Map<string, ScheduleItem[] | null>();
    for (const s of r.value) {
      // An error means Graph could not read that calendar; callers treat it as unknown, not free.
      out.set(
        s.scheduleId.toLowerCase(),
        s.error
          ? null
          : (s.scheduleItems ?? []).flatMap((i) => {
              const start = parseGraphDate(i.start);
              const end = parseGraphDate(i.end);
              return start && end ? [{ status: i.status, start, end }] : [];
            })
      );
    }
    return out;
  }

  // Teams -------------------------------------------------------------------

  /** The online meeting behind a calendar event's join link. Only the organizer can read it. */
  async findOnlineMeeting(joinUrl: string) {
    const filter = encodeURIComponent(`JoinWebUrl eq '${joinUrl.replaceAll("'", "''")}'`);
    const r = await this.request<{ value: { id: string; subject?: string }[] }>(`/me/onlineMeetings?$filter=${filter}`);
    return r.value[0] ?? null;
  }

  listTranscripts(onlineMeetingId: string) {
    return this.request<{ value: { id: string; createdDateTime: string }[] }>(
      `/me/onlineMeetings/${encodeURIComponent(onlineMeetingId)}/transcripts`
    ).then((r) => r.value);
  }

  transcriptVtt(onlineMeetingId: string, transcriptId: string) {
    return this.request<string>(
      `/me/onlineMeetings/${encodeURIComponent(onlineMeetingId)}/transcripts/${encodeURIComponent(transcriptId)}/content?$format=text/vtt`,
      { raw: true }
    );
  }

  // Mail and contacts (also used by Relay's Outlook channel) ----------------

  messagesWith(email: string, top = 5) {
    const q = encodeURIComponent(`"participants:${email.replaceAll('"', "")}"`);
    return this.request<{ value: { id: string; subject?: string; receivedDateTime?: string; bodyPreview?: string; from?: { emailAddress: { address: string } } }[] }>(
      `/me/messages?$search=${q}&$top=${top}&$select=id,subject,receivedDateTime,bodyPreview,from`
    ).then((r) => r.value);
  }

  searchContacts(query: string, top = 10) {
    const q = encodeURIComponent(`"${query.replaceAll('"', "")}"`);
    return this.request<{ value: { id: string; displayName?: string; emailAddresses?: { address: string }[]; mobilePhone?: string; companyName?: string }[] }>(
      `/me/contacts?$search=${q}&$top=${top}`
    ).then((r) => r.value);
  }

  /** A draft in the user's Drafts folder. Nothing is sent. */
  createDraft(mail: { to: string[]; subject: string; body: string }) {
    return this.request<{ id: string; webLink?: string }>("/me/messages", {
      method: "POST",
      body: JSON.stringify({
        subject: mail.subject,
        body: { contentType: "Text", content: mail.body },
        toRecipients: mail.to.map((address) => ({ emailAddress: { address } })),
      }),
    });
  }

  createReplyDraft(messageId: string, body: string) {
    return this.request<{ id: string }>(`/me/messages/${encodeURIComponent(messageId)}/createReply`, {
      method: "POST",
      body: JSON.stringify({ comment: body }),
    });
  }

  /** Sends an existing draft. Callers own approval and idempotency (Relay's send grant). */
  sendDraft(draftId: string) {
    return this.request(`/me/messages/${encodeURIComponent(draftId)}/send`, { method: "POST" });
  }

  // Subscriptions -----------------------------------------------------------

  createSubscription(input: {
    resource: string;
    changeType: string;
    notificationUrl: string;
    lifecycleNotificationUrl: string;
    clientState: string;
    expiresAt: Date;
  }) {
    return this.request<GraphSubscriptionResponse>("/subscriptions", {
      method: "POST",
      body: JSON.stringify({
        resource: input.resource,
        changeType: input.changeType,
        notificationUrl: input.notificationUrl,
        lifecycleNotificationUrl: input.lifecycleNotificationUrl,
        clientState: input.clientState,
        expirationDateTime: input.expiresAt.toISOString(),
      }),
    });
  }

  renewSubscription(id: string, expiresAt: Date) {
    return this.request<GraphSubscriptionResponse>(`/subscriptions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ expirationDateTime: expiresAt.toISOString() }),
    });
  }

  deleteSubscription(id: string) {
    return this.request(`/subscriptions/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
}
