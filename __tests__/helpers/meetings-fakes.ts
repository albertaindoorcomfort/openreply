/**
 * In-memory stand-ins for Microsoft Graph (as a fetch function, so the real
 * GraphClient HTTP code runs) and for Relay's adapter API.
 */
import type { GraphEvent } from "../../lib/microsoft/graph";
import type { RelayApi, RelayContact, RelayContactProfile, TaskInput, TimelineInput } from "../../lib/meetings/relay-client";

type Busy = { email: string; start: string; end: string; status?: string };

export class FakeGraph {
  events = new Map<string, GraphEvent>();
  busy: Busy[] = [];
  unreadableCalendars = new Set<string>();
  calls: { method: string; path: string; body?: unknown; headers: Record<string, string> }[] = [];
  /** path prefix -> status to return once (or always with `sticky`). */
  failures: { match: RegExp; status: number; code?: string; sticky?: boolean }[] = [];
  subscriptions = new Map<string, { expirationDateTime: string }>();
  onlineMeetings = new Map<string, string>(); // joinUrl -> id
  transcripts = new Map<string, { id: string; createdDateTime: string; vtt: string }[]>();
  drafts: { id: string; to: string[]; subject: string; body: string }[] = [];
  private seq = 0;
  private readonly run = Math.random().toString(36).slice(2, 8);

  private nextId(p: string) {
    return `${p}${this.run}${++this.seq}`;
  }

  addEvent(e: Omit<Partial<GraphEvent>, "start" | "end"> & { start: string; end: string }) {
    const id = e.id ?? this.nextId("evt");
    const ev: GraphEvent = {
      changeKey: `ck${++this.seq}`,
      subject: "Meeting",
      attendees: [],
      ...e,
      id,
      start: { dateTime: e.start.replace("Z", ""), timeZone: "UTC" },
      end: { dateTime: e.end.replace("Z", ""), timeZone: "UTC" },
    };
    this.events.set(id, ev);
    return ev;
  }

  /** Simulates someone editing the event in Outlook. */
  editInOutlook(id: string, patch: Partial<GraphEvent>) {
    const ev = this.events.get(id)!;
    this.events.set(id, { ...ev, ...patch, changeKey: `ck${++this.seq}` });
  }

  count(method: string, re: RegExp) {
    return this.calls.filter((c) => c.method === method && re.test(c.path)).length;
  }

  fetch: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const path = decodeURIComponent(url.pathname.replace(/^\/v1\.0/, "")) + (url.search ? decodeURIComponent(url.search) : "");
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({ method, path, body, headers });

    const fail = this.failures.find((f) => f.match.test(`${method} ${path}`));
    if (fail) {
      if (!fail.sticky) this.failures.splice(this.failures.indexOf(fail), 1);
      return json(fail.status, { error: { code: fail.code ?? "Failure", message: "secret detail jordan@example.com" } });
    }
    return this.route(method, url, path, body, headers);
  };

  // Request bodies are whatever GraphClient sent; the fake reads them loosely.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private route(method: string, url: URL, path: string, body: any, headers: Record<string, string>): Response {
    const p = url.pathname.replace(/^\/v1\.0/, "");
    if (method === "POST" && p === "/me/calendar/getSchedule") {
      return json(200, {
        value: body.schedules.map((email: string) =>
          this.unreadableCalendars.has(email)
            ? { scheduleId: email, error: { message: "no access" } }
            : {
                scheduleId: email,
                scheduleItems: this.busy
                  .filter((b) => b.email === email)
                  .map((b) => ({ status: b.status ?? "busy", start: { dateTime: b.start.replace("Z", ""), timeZone: "UTC" }, end: { dateTime: b.end.replace("Z", ""), timeZone: "UTC" } })),
              }
        ),
      });
    }
    if (method === "POST" && p === "/me/events") {
      const dup = [...this.events.values()].find((e) => e.transactionId && e.transactionId === body.transactionId);
      if (dup) return json(201, dup);
      const ev = this.addEvent({
        subject: body.subject,
        start: `${body.start.dateTime}Z`,
        end: `${body.end.dateTime}Z`,
        attendees: body.attendees,
        transactionId: body.transactionId,
        isOnlineMeeting: body.isOnlineMeeting,
        onlineMeeting: body.isOnlineMeeting ? { joinUrl: `https://teams.example/join/${this.seq}` } : null,
        organizer: { emailAddress: { address: "owner@aic.example" } },
      });
      // Also block the organizer's calendar like Outlook would.
      this.busy.push({ email: "owner@aic.example", start: `${body.start.dateTime}Z`, end: `${body.end.dateTime}Z` });
      return json(201, ev);
    }
    const eventMatch = p.match(/^\/me\/events\/([^/]+)$/);
    if (eventMatch) {
      const ev = this.events.get(eventMatch[1]);
      if (!ev) return json(404, { error: { code: "ErrorItemNotFound" } });
      if (method === "GET") return json(200, ev);
      if (method === "PATCH") {
        if (headers["if-match"] && headers["if-match"] !== `W/"${ev.changeKey}"`) return json(412, { error: { code: "ErrorIrresolvableConflict" } });
        const next = { ...ev, ...("start" in body ? { start: body.start, end: body.end } : {}), changeKey: `ck${++this.seq}` };
        this.events.set(ev.id, next);
        return json(200, next);
      }
    }
    if (method === "POST" && /^\/me\/events\/[^/]+\/cancel$/.test(p)) return new Response(null, { status: 202 });
    if (method === "GET" && p === "/me/calendarView/delta") {
      if (url.searchParams.get("$deltatoken") === "expired") return json(410, { error: { code: "SyncStateNotFound" } });
      return json(200, { value: [...this.events.values()], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=t1" });
    }
    if (method === "GET" && p === "/me/onlineMeetings") {
      const join = (url.searchParams.get("$filter") ?? "").match(/'(.+)'/)?.[1]?.replaceAll("''", "'");
      const id = join ? this.onlineMeetings.get(join) : undefined;
      return json(200, { value: id ? [{ id }] : [] });
    }
    const tr = p.match(/^\/me\/onlineMeetings\/([^/]+)\/transcripts(?:\/([^/]+)\/content)?$/);
    if (tr && method === "GET") {
      const list = this.transcripts.get(tr[1]) ?? [];
      if (!tr[2]) return json(200, { value: list.map(({ id, createdDateTime }) => ({ id, createdDateTime })) });
      const t = list.find((x) => x.id === tr[2]);
      return t ? new Response(t.vtt, { status: 200, headers: { "content-type": "text/vtt" } }) : json(404, {});
    }
    if (method === "GET" && p === "/me/messages") return json(200, { value: [] });
    if (method === "POST" && p === "/me/messages") {
      const d = { id: this.nextId("draft"), to: body.toRecipients.map((r: { emailAddress: { address: string } }) => r.emailAddress.address), subject: body.subject, body: body.body.content };
      this.drafts.push(d);
      return json(201, { id: d.id });
    }
    if (method === "POST" && p === "/subscriptions") {
      const id = this.nextId("sub");
      this.subscriptions.set(id, { expirationDateTime: body.expirationDateTime });
      return json(201, { id, expirationDateTime: body.expirationDateTime, resource: body.resource });
    }
    const sub = p.match(/^\/subscriptions\/([^/]+)$/);
    if (sub) {
      if (!this.subscriptions.has(sub[1])) return json(404, { error: { code: "ResourceNotFound" } });
      if (method === "DELETE") {
        this.subscriptions.delete(sub[1]);
        return new Response(null, { status: 204 });
      }
      this.subscriptions.set(sub[1], { expirationDateTime: body.expirationDateTime });
      return json(200, { id: sub[1], expirationDateTime: body.expirationDateTime, resource: "me/events" });
    }
    return json(404, { error: { code: "UnhandledInFake", path } });
  }
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export class FakeRelay implements RelayApi {
  contacts = new Map<string, RelayContactProfile>();
  timeline: TimelineInput[] = [];
  tasks: (TaskInput & { id: string })[] = [];
  drafts: { conversationId: string; body: string; idempotencyKey: string; id: string }[] = [];
  failTimeline = 0;

  addContact(c: Partial<RelayContactProfile> & { id: string; primaryEmail: string }) {
    this.contacts.set(c.id, { conversations: [], tasks: [], opportunities: [], ...c } as RelayContactProfile);
  }
  async findContactsByEmail(email: string): Promise<RelayContact[]> {
    return [...this.contacts.values()].filter((c) => c.primaryEmail === email);
  }
  async getContact(id: string) {
    return this.contacts.get(id) ?? null;
  }
  async postTimeline(event: TimelineInput) {
    if (this.failTimeline > 0) {
      this.failTimeline--;
      throw new Error("relay 503");
    }
    // Relay dedupes on idempotencyKey per workspace.
    if (!this.timeline.some((t) => t.idempotencyKey === event.idempotencyKey)) this.timeline.push(event);
  }
  async createTask(task: TaskInput) {
    const existing = this.tasks.find((t) => t.idempotencyKey === task.idempotencyKey);
    if (existing) return { id: existing.id };
    const t = { ...task, id: `task${this.tasks.length + 1}` };
    this.tasks.push(t);
    return { id: t.id };
  }
  async createDraft(conversationId: string, draft: { body: string; idempotencyKey: string }) {
    const d = { conversationId, body: draft.body, idempotencyKey: draft.idempotencyKey, id: `rdraft${this.drafts.length + 1}` };
    this.drafts.push(d);
    return { id: d.id };
  }
}
