import { z } from "zod";

/**
 * Client for the lead model's adapter API (/api/relay/v1). Contacts, tasks,
 * conversations and drafts are canonical there; meetings only link to them.
 * The service key is workspace scoped, so the key decides the workspace.
 */

export class RelayError extends Error {
  constructor(readonly status: number, readonly code: string, readonly path: string) {
    super(`relay ${status} ${code} ${path}`);
  }
}

const contactSummary = z
  .object({
    id: z.string(),
    displayName: z.string().nullish(),
    primaryEmail: z.string().nullish(),
    primaryPhone: z.string().nullish(),
    company: z.string().nullish(),
    stageKey: z.string().nullish(),
    ownerUserId: z.string().nullish(),
    leadScore: z.number().nullish(),
  })
  .passthrough();
export type RelayContact = z.infer<typeof contactSummary>;

const contactProfile = contactSummary.extend({
  conversations: z
    .array(z.object({ id: z.string(), channel: z.string(), subject: z.string().nullish(), status: z.string().nullish(), lastInboundAt: z.string().nullish() }).passthrough())
    .default([]),
  tasks: z
    .array(z.object({ id: z.string(), title: z.string(), status: z.string(), dueAt: z.string().nullish() }).passthrough())
    .default([]),
  opportunities: z
    .array(z.object({ id: z.string(), title: z.string().nullish(), stageKey: z.string().nullish(), valueCents: z.number().nullish(), outcome: z.string().nullish() }).passthrough())
    .default([]),
  latestAssessment: z
    .object({ summary: z.string().nullish(), intent: z.string().nullish(), urgency: z.string().nullish(), nextActions: z.unknown().optional() })
    .passthrough()
    .nullish(),
});
export type RelayContactProfile = z.infer<typeof contactProfile>;

export interface TimelineInput {
  type: "meeting.scheduled" | "meeting.rescheduled" | "meeting.completed" | "meeting.notes_linked";
  idempotencyKey: string;
  contactId?: string | null;
  opportunityId?: string | null;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export interface TaskInput {
  title: string;
  notes?: string;
  dueAt?: string | null;
  remindAt?: string | null;
  priority?: "LOW" | "NORMAL" | "HIGH";
  contactId?: string | null;
  opportunityId?: string | null;
  conversationId?: string | null;
  assigneeUserId?: string | null;
  idempotencyKey: string;
}

export interface RelayApi {
  findContactsByEmail(email: string): Promise<RelayContact[]>;
  getContact(id: string): Promise<RelayContactProfile | null>;
  postTimeline(event: TimelineInput): Promise<void>;
  createTask(task: TaskInput): Promise<{ id: string }>;
  createDraft(conversationId: string, draft: { body: string; rationale: string; evidence: unknown[]; idempotencyKey: string }): Promise<{ id: string }>;
}

export class RelayClient implements RelayApi {
  constructor(
    private readonly baseUrl: string,
    private readonly key: string,
    private readonly f: typeof fetch = fetch
  ) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.f(`${this.baseUrl.replace(/\/$/, "")}/api/relay/v1${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.key}`, "content-type": "application/json", ...init.headers },
      signal: init.signal ?? AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) throw new RelayError(res.status, typeof json.error === "string" ? json.error : "error", path.split("?")[0]);
    return json as T;
  }

  async findContactsByEmail(email: string) {
    const r = await this.call<{ contacts?: unknown[]; data?: unknown[] }>(`/contacts?q=${encodeURIComponent(email)}`);
    const list = z.array(contactSummary).parse(r.contacts ?? r.data ?? []);
    // q is a fuzzy search; only an exact primary or identity match links a meeting.
    const wanted = email.toLowerCase();
    return list.filter((c) => {
      if ((c.primaryEmail ?? "").toLowerCase() === wanted) return true;
      const identities = Array.isArray(c.identities) ? (c.identities as { kind?: string; value?: string }[]) : [];
      return identities.some((i) => i.kind === "EMAIL" && (i.value ?? "").toLowerCase() === wanted);
    });
  }

  async getContact(id: string) {
    try {
      const r = await this.call<{ contact?: unknown }>(`/contacts/${encodeURIComponent(id)}`);
      return contactProfile.parse(r.contact ?? r);
    } catch (error) {
      if (error instanceof RelayError && error.status === 404) return null;
      throw error;
    }
  }

  async postTimeline(event: TimelineInput) {
    await this.call("/timeline", { method: "POST", body: JSON.stringify(event) });
  }

  async createTask(task: TaskInput) {
    const r = await this.call<{ task?: { id: string }; id?: string }>("/tasks", {
      method: "POST",
      headers: { "idempotency-key": task.idempotencyKey },
      body: JSON.stringify({ ...task, createdByKind: "AGENT", createdById: "carla" }),
    });
    return { id: r.task?.id ?? r.id ?? "" };
  }

  async createDraft(conversationId: string, draft: { body: string; rationale: string; evidence: unknown[]; idempotencyKey: string }) {
    const r = await this.call<{ draft?: { id: string }; id?: string }>(
      `/conversations/${encodeURIComponent(conversationId)}/drafts`,
      { method: "POST", headers: { "idempotency-key": draft.idempotencyKey }, body: JSON.stringify(draft) }
    );
    return { id: r.draft?.id ?? r.id ?? "" };
  }
}

/** Null when Relay is not configured; meetings then keep working unlinked. */
export function relayFromEnv(): RelayApi | null {
  const base = process.env.RELAY_API_URL ?? process.env.NEXTAUTH_URL;
  const key = process.env.RELAY_SERVICE_KEY;
  return base && key ? new RelayClient(base, key) : null;
}
