# Intent Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A campaign can require that a comment or DM *means* what the campaign offers — one TypeSafe (Jev) yes/no judgment, thresholded in code — instead of only containing a keyword.

**Architecture:** Keyword matching stays as the cheap reach test. A new `lib/matching/` layer runs one batched judgment per comment over every gated candidate campaign, returns pass/reject per campaign, and the worker consumes that before its existing per-campaign loop. Rejections write a `SKIPPED_NO_MATCH` `DmLog` row (with the probability) so the reconciler treats them as handled and never re-bills. Fails closed; absent `TYPESAFE_API_KEY` means gated campaigns are closed and everything else is unchanged.

**Tech Stack:** Next.js 16, Prisma 7 (Postgres), BullMQ worker, Vitest 4, `@typesafe-ai/sdk` 0.6.0, Zod 4, Tailwind 4.

**Spec:** `docs/superpowers/specs/2026-09-28-intent-gate-design.md`. Run everything from the repository root, on branch `feat/intent-gate`.

---

**Executed 2026-09-28/29.** Tasks 5–7 were implemented differently from the text below after code review: matching moved into `lib/queue/campaign-matching.ts` with a decide-once rule, closures are recoverable, and a provider outage no longer blocks ungated campaigns. The spec is the accurate description; see its final section.

## File structure

| Path | Responsibility |
|---|---|
| `prisma/schema.prisma` | +3 columns on `Automation`, +1 on `DmLog` |
| `prisma/migrations/20260928120000_intent_gate/migration.sql` | The four `ALTER TABLE`s |
| `lib/env.ts` | `getTypeSafeApiKey()` — returns `null`, never throws |
| `lib/matching/judgment-provider.ts` | `JudgmentProvider` interface, `IntentJudgmentUnavailableError`, fake provider, TypeSafe provider, `getJudgmentProvider()` singleton. Only file that imports the SDK client. |
| `lib/matching/intent-gate.ts` | `buildIntentRequest` (state + one Noul per candidate) and `gateIntents` (threshold → verdicts) |
| `lib/matching/match-campaign.ts` | `matchCampaigns`: reach (keywords) + meaning (gate) → one result per campaign, one provider call |
| `lib/queue/dm-worker.ts` | Comment path and DM path call `matchCampaigns` before their loops; rejections write `SKIPPED_NO_MATCH`; short-circuit on prior rejection rows |
| `lib/polling/comment-reconciler.ts` | `SKIPPED_NO_MATCH` counts as fully handled |
| `worker/dm-worker.ts` | Boot-time warning when gated campaigns exist but no key |
| `app/api/automations/route.ts`, `app/api/automations/import/route.ts` | Accept + validate the three fields |
| `components/campaign-builder.tsx` | Toggle, description, advanced threshold |
| `app/(dashboard)/logs/page.tsx` | Show probability on gated rows |
| `lib/i18n/zh-TW.json` | Translations for every new string |
| `.env.example`, `docs/setup.md` | Optional key, one doc section |
| `__tests__/judgment-provider.test.ts`, `__tests__/intent-gate.test.ts`, `__tests__/match-campaign.test.ts`, `__tests__/intent-gate.live.test.ts` | New suites |
| `__tests__/dm-worker.test.ts`, `__tests__/comment-reconciler.test.ts`, `__tests__/env.test.ts` | Extended |

Unchanged on purpose: `lib/utils/keyword-matcher.ts`; `lib/campaigns/duplicate.ts` (spreads the whole row, so the new columns copy automatically); `app/api/admin/diagnostics/route.ts` (already lists `SKIPPED_NO_MATCH`); `components/status-badge.tsx` (already renders it as "No match"); `app/api/logs/route.ts` (uses `include`, not `select`, so `intentProbability` comes through).

Every commit ends with:

```
Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

---

### Task 0: Environment

**Files:** none changed except `package.json` / `package-lock.json`.

- [ ] **Step 1: Start Docker Desktop** (the daemon is currently down). Then:

Run: `docker info --format '{{.ServerVersion}}'`
Expected: a version string, not an npipe error.

- [ ] **Step 2: Install deps and start Postgres + Redis**

```bash
npm install && docker compose up -d
```

- [ ] **Step 3: Create `.env` for local work**

```bash
cp .env.example .env
```

Set `ENCRYPTION_KEY` to 64 hex chars (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`), `NEXTAUTH_SECRET` to any long random string. Leave Meta/Resend values as placeholders — nothing in this plan needs them. Do **not** set `TYPESAFE_API_KEY` yet.

- [ ] **Step 4: Baseline**

```bash
npm run db:generate && npm run db:migrate && npm test
```

Expected: all suites pass. If `tracked-link-order.db.test.ts` needs the DB, it is up.

- [ ] **Step 5: Add the SDK**

```bash
npm install @typesafe-ai/sdk@^0.6.0
```

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add @typesafe-ai/sdk for the intent gate

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 1: Schema, migration, env helper

**Files:**
- Modify: `prisma/schema.prisma` (model `Automation` after `wholeWordMatch`; model `DmLog` after `matchedKeyword`)
- Create: `prisma/migrations/20260928120000_intent_gate/migration.sql`
- Modify: `lib/env.ts`
- Test: `__tests__/env.test.ts`

- [ ] **Step 1: Write the failing env test** — append inside `describe("environment helpers")` in `__tests__/env.test.ts`, and add `getTypeSafeApiKey` to the import list:

```ts
  it("treats a missing TypeSafe key as absent, not an error", () => {
    expect(getTypeSafeApiKey()).toBeNull();
    vi.stubEnv("TYPESAFE_API_KEY", "   ");
    expect(getTypeSafeApiKey()).toBeNull();
    vi.stubEnv("TYPESAFE_API_KEY", "ts_live_abc");
    expect(getTypeSafeApiKey()).toBe("ts_live_abc");
  });
```

- [ ] **Step 2: Run it**

Run: `npx vitest run __tests__/env.test.ts`
Expected: FAIL — `getTypeSafeApiKey` is not exported.

- [ ] **Step 3: Implement** — append to `lib/env.ts` after `getMetaGraphApiVersion`:

```ts
/**
 * Optional TypeSafe key for the campaign intent gate. Absence is a valid
 * configuration — gated campaigns are simply closed — so this returns null
 * instead of throwing like requireEnv().
 */
export function getTypeSafeApiKey(): string | null {
  const value = process.env.TYPESAFE_API_KEY?.trim();
  return value ? value : null;
}
```

- [ ] **Step 4: Run it**

Run: `npx vitest run __tests__/env.test.ts`
Expected: PASS.

- [ ] **Step 5: Schema** — in `prisma/schema.prisma`, `model Automation`, directly after `wholeWordMatch Boolean @default(true)`:

```prisma
  // Intent gate: when on, a comment must also *mean* what the campaign offers
  // (judged by TypeSafe) before any DM is sent. Off by default, so every
  // existing campaign behaves exactly as before.
  intentGateEnabled Boolean @default(false)
  intentDescription String?
  intentThreshold   Float   @default(0.7)
```

In `model DmLog`, directly after `matchedKeyword String?`:

```prisma
  // Probability the intent gate returned for this comment, when a gate ran.
  // Null on every keyword-only row, so gated rows are identifiable.
  intentProbability Float?
```

- [ ] **Step 6: Migration** — create `prisma/migrations/20260928120000_intent_gate/migration.sql`:

```sql
-- Intent gate: a campaign may require that a comment means what it offers,
-- not just that it contains a keyword. All four columns are additive with
-- defaults, so existing rows keep today's behaviour and no backfill runs.

-- AlterTable
ALTER TABLE "Automation" ADD COLUMN "intentGateEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Automation" ADD COLUMN "intentDescription" TEXT;
ALTER TABLE "Automation" ADD COLUMN "intentThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.7;

-- AlterTable
ALTER TABLE "DmLog" ADD COLUMN "intentProbability" DOUBLE PRECISION;
```

- [ ] **Step 7: Apply and regenerate**

```bash
npm run db:migrate && npm run db:generate && npm run typecheck
```

Expected: migration applied, typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add prisma lib/env.ts __tests__/env.test.ts
git commit -m "feat(schema): intent gate columns and optional TypeSafe key

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Judgment provider

**Files:**
- Create: `lib/matching/judgment-provider.ts`
- Test: `__tests__/judgment-provider.test.ts`

- [ ] **Step 1: Write the failing tests** — `__tests__/judgment-provider.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakeJudgmentProvider,
  getJudgmentProvider,
  IntentJudgmentUnavailableError,
  resetJudgmentProviderForTests,
  TypeSafeJudgmentProvider,
  type IntentRequest,
} from "../lib/matching/judgment-provider";

const request: IntentRequest = {
  state: { comment: { text: "how much?", authorHandle: "sam" }, campaigns: { a1: { offer: "tune-up" } } },
  questions: { a1: { type: "noul", instructions: "q", criteria: { true: "y", false: "n" } } },
};

afterEach(() => {
  vi.unstubAllEnvs();
  resetJudgmentProviderForTests();
});

describe("fake provider", () => {
  it("returns configured probabilities and records calls", async () => {
    const fake = createFakeJudgmentProvider({ a1: 0.9 });
    await expect(fake.judgeIntents(request)).resolves.toEqual({ a1: 0.9 });
    expect(fake.calls).toEqual([request]);
  });
});

describe("TypeSafe provider", () => {
  it("maps each noul answer to its campaign id", async () => {
    const systemOne = vi.fn().mockResolvedValue({
      answers: { a1: { type: "noul", noul: 0.82 } },
    });
    const provider = new TypeSafeJudgmentProvider({ systemOne });
    await expect(provider.judgeIntents(request)).resolves.toEqual({ a1: 0.82 });
    expect(systemOne).toHaveBeenCalledWith(request);
  });

  it("wraps any client failure as IntentJudgmentUnavailableError", async () => {
    const systemOne = vi.fn().mockRejectedValue(new Error("503 upstream"));
    const provider = new TypeSafeJudgmentProvider({ systemOne });
    await expect(provider.judgeIntents(request)).rejects.toBeInstanceOf(
      IntentJudgmentUnavailableError
    );
  });

  it("treats a missing answer as unavailable rather than a silent zero", async () => {
    const systemOne = vi.fn().mockResolvedValue({ answers: {} });
    const provider = new TypeSafeJudgmentProvider({ systemOne });
    await expect(provider.judgeIntents(request)).rejects.toBeInstanceOf(
      IntentJudgmentUnavailableError
    );
  });
});

describe("getJudgmentProvider", () => {
  it("is null without a key", () => {
    expect(getJudgmentProvider()).toBeNull();
  });

  it("returns a TypeSafe provider once a key is present, and memoizes", () => {
    vi.stubEnv("TYPESAFE_API_KEY", "ts_test_key");
    const first = getJudgmentProvider();
    expect(first).toBeInstanceOf(TypeSafeJudgmentProvider);
    expect(getJudgmentProvider()).toBe(first);
  });
});
```

- [ ] **Step 2: Run**

Run: `npx vitest run __tests__/judgment-provider.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `lib/matching/judgment-provider.ts`:

```ts
import { TypeSafeClient, type EntryType, type NoulQuestion } from "@typesafe-ai/sdk";
import { getTypeSafeApiKey } from "@/lib/env";

/** One batched request: shared state plus one Noul per gated campaign, keyed by campaign id. */
export interface IntentRequest {
  state: EntryType;
  questions: Record<string, NoulQuestion>;
}

/** Probability of "yes" per campaign id. */
export type IntentProbabilities = Record<string, number>;

export interface JudgmentProvider {
  judgeIntents(request: IntentRequest): Promise<IntentProbabilities>;
}

/**
 * Thrown when no judgment could be obtained. The gate fails closed: the
 * worker lets this propagate so BullMQ retries the job, and nothing is sent.
 */
export class IntentJudgmentUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "IntentJudgmentUnavailableError";
  }
}

export interface FakeJudgmentProvider extends JudgmentProvider {
  calls: IntentRequest[];
}

/** Deterministic provider for tests. Accepts fixed probabilities or a function of the request. */
export function createFakeJudgmentProvider(
  probabilities:
    | IntentProbabilities
    | ((request: IntentRequest) => IntentProbabilities | Promise<IntentProbabilities>)
): FakeJudgmentProvider {
  const calls: IntentRequest[] = [];
  return {
    calls,
    async judgeIntents(request) {
      calls.push(request);
      return typeof probabilities === "function" ? probabilities(request) : probabilities;
    },
  };
}

/** The slice of TypeSafeClient this provider uses; narrow so tests can hand in a stub. */
export interface SystemOneClient {
  systemOne(
    request: IntentRequest
  ): PromiseLike<{ answers: Record<string, { noul: number } | undefined> }>;
}

export class TypeSafeJudgmentProvider implements JudgmentProvider {
  constructor(private readonly client: SystemOneClient) {}

  async judgeIntents(request: IntentRequest): Promise<IntentProbabilities> {
    let result: Awaited<ReturnType<SystemOneClient["systemOne"]>>;
    try {
      result = await this.client.systemOne(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      throw new IntentJudgmentUnavailableError(`TypeSafe request failed: ${message}`, {
        cause: error,
      });
    }

    const out: IntentProbabilities = {};
    for (const id of Object.keys(request.questions)) {
      const answer = result.answers[id];
      if (!answer || typeof answer.noul !== "number") {
        throw new IntentJudgmentUnavailableError(`TypeSafe returned no answer for ${id}`);
      }
      out[id] = answer.noul;
    }
    return out;
  }
}

let cached: JudgmentProvider | null | undefined;

/** Process-wide provider, or null when TYPESAFE_API_KEY is not set. */
export function getJudgmentProvider(): JudgmentProvider | null {
  if (cached !== undefined) return cached;
  const apiKey = getTypeSafeApiKey();
  if (!apiKey) {
    cached = null;
    return cached;
  }
  const client = new TypeSafeClient({ apiKey });
  cached = new TypeSafeJudgmentProvider({
    systemOne: (request) => client.systemOne(request),
  });
  return cached;
}

export function resetJudgmentProviderForTests(): void {
  cached = undefined;
}
```

- [ ] **Step 4: Run**

Run: `npx vitest run __tests__/judgment-provider.test.ts && npm run typecheck`
Expected: PASS, typecheck clean. If `systemOne`'s generic return does not assign to `PromiseLike<...>`, cast the wrapper: `systemOne: (request) => client.systemOne(request) as unknown as PromiseLike<{ answers: Record<string, { noul: number } | undefined> }>` and leave a one-line comment saying why.

- [ ] **Step 5: Commit**

```bash
git add lib/matching/judgment-provider.ts __tests__/judgment-provider.test.ts
git commit -m "feat(matching): judgment provider with TypeSafe and fake implementations

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Intent gate (state, questions, thresholds)

**Files:**
- Create: `lib/matching/intent-gate.ts`
- Test: `__tests__/intent-gate.test.ts`

- [ ] **Step 1: Failing tests** — `__tests__/intent-gate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildIntentRequest, gateIntents } from "../lib/matching/intent-gate";
import {
  createFakeJudgmentProvider,
  IntentJudgmentUnavailableError,
} from "../lib/matching/judgment-provider";

const input = {
  comment: { text: "how much is the tune up?", authorHandle: "sam_yyc" },
  candidates: [
    { campaignId: "c_tuneup", offer: "a free furnace tune-up booking link", threshold: 0.7 },
    { campaignId: "c_hiring", offer: "a link to open technician job postings", threshold: 0.6 },
  ],
};

describe("buildIntentRequest", () => {
  it("puts the comment and every offer in named state, one noul per campaign", () => {
    const request = buildIntentRequest(input);
    expect(request.state).toEqual({
      comment: { text: "how much is the tune up?", authorHandle: "sam_yyc" },
      campaigns: {
        c_tuneup: { offer: "a free furnace tune-up booking link" },
        c_hiring: { offer: "a link to open technician job postings" },
      },
    });
    expect(Object.keys(request.questions)).toEqual(["c_tuneup", "c_hiring"]);
    const q = request.questions.c_tuneup;
    expect(q.type).toBe("noul");
    expect(String(q.instructions)).toContain("`comment.text`");
    expect(String(q.instructions)).toContain("`campaigns.c_tuneup.offer`");
    expect(q.criteria?.true).toBeTruthy();
    expect(q.criteria?.false).toBeTruthy();
  });

  it("allows a null author handle", () => {
    const request = buildIntentRequest({ ...input, comment: { text: "x", authorHandle: null } });
    expect((request.state as { comment: { authorHandle: null } }).comment.authorHandle).toBeNull();
  });
});

describe("gateIntents", () => {
  it("passes at or above each campaign's own threshold and rejects below", async () => {
    const provider = createFakeJudgmentProvider({ c_tuneup: 0.7, c_hiring: 0.59 });
    await expect(gateIntents(input, provider)).resolves.toEqual([
      { campaignId: "c_tuneup", outcome: "pass", probability: 0.7 },
      { campaignId: "c_hiring", outcome: "reject", probability: 0.59 },
    ]);
    expect(provider.calls).toHaveLength(1);
  });

  it("makes no call for zero candidates", async () => {
    const provider = createFakeJudgmentProvider({});
    await expect(gateIntents({ ...input, candidates: [] }, provider)).resolves.toEqual([]);
    expect(provider.calls).toHaveLength(0);
  });

  it("fails closed when a probability is missing", async () => {
    const provider = createFakeJudgmentProvider({ c_tuneup: 0.9 });
    await expect(gateIntents(input, provider)).rejects.toBeInstanceOf(
      IntentJudgmentUnavailableError
    );
  });
});
```

- [ ] **Step 2: Run**

Run: `npx vitest run __tests__/intent-gate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `lib/matching/intent-gate.ts`:

```ts
import { noul, type NoulQuestion } from "@typesafe-ai/sdk";
import {
  IntentJudgmentUnavailableError,
  type IntentRequest,
  type JudgmentProvider,
} from "./judgment-provider";

export interface IntentCandidate {
  campaignId: string;
  /** The campaign's intentDescription — what it offers, in the owner's words. */
  offer: string;
  /** Probability of "yes" at or above which the gate passes. */
  threshold: number;
}

export interface IntentGateInput {
  comment: { text: string; authorHandle: string | null };
  candidates: IntentCandidate[];
}

export interface IntentVerdict {
  campaignId: string;
  outcome: "pass" | "reject";
  probability: number;
}

const YES =
  "The commenter is requesting the offer or asking how to get it: price, link, booking, availability, or \"how do I\".";
const NO =
  "Anything else: general praise, an unrelated question, a complaint, a job or partnership inquiry, spam, a competitor, or a reply addressed to another commenter.";

/**
 * One request for the whole comment. The state names every part so each
 * question can point at it; question ids are campaign ids and are for code —
 * the full meaning is in the instruction text and criteria.
 */
export function buildIntentRequest(input: IntentGateInput): IntentRequest {
  const campaigns: Record<string, { offer: string }> = {};
  const questions: Record<string, NoulQuestion> = {};

  for (const candidate of input.candidates) {
    campaigns[candidate.campaignId] = { offer: candidate.offer };
    questions[candidate.campaignId] = noul(
      `Does \`comment.text\` ask for, or express clear interest in receiving, what \`campaigns.${candidate.campaignId}.offer\` describes?`,
      { true: YES, false: NO }
    );
  }

  return {
    state: {
      comment: { text: input.comment.text, authorHandle: input.comment.authorHandle },
      campaigns,
    },
    questions,
  };
}

/** Ask once, threshold per campaign. Throws IntentJudgmentUnavailableError rather than guessing. */
export async function gateIntents(
  input: IntentGateInput,
  provider: JudgmentProvider
): Promise<IntentVerdict[]> {
  if (input.candidates.length === 0) return [];

  const probabilities = await provider.judgeIntents(buildIntentRequest(input));

  return input.candidates.map((candidate) => {
    const probability = probabilities[candidate.campaignId];
    if (typeof probability !== "number") {
      throw new IntentJudgmentUnavailableError(
        `No intent probability returned for campaign ${candidate.campaignId}`
      );
    }
    return {
      campaignId: candidate.campaignId,
      outcome: probability >= candidate.threshold ? "pass" : "reject",
      probability,
    };
  });
}
```

- [ ] **Step 4: Run**

Run: `npx vitest run __tests__/intent-gate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/matching/intent-gate.ts __tests__/intent-gate.test.ts
git commit -m "feat(matching): intent gate builds one batched noul request and thresholds it

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: matchCampaigns — reach plus meaning

**Files:**
- Create: `lib/matching/match-campaign.ts`
- Test: `__tests__/match-campaign.test.ts`

- [ ] **Step 1: Failing tests** — `__tests__/match-campaign.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { matchCampaigns, type MatchableCampaign } from "../lib/matching/match-campaign";
import { matchKeywords } from "../lib/utils/keyword-matcher";
import {
  createFakeJudgmentProvider,
  IntentJudgmentUnavailableError,
} from "../lib/matching/judgment-provider";

function campaign(overrides: Partial<MatchableCampaign> = {}): MatchableCampaign {
  return {
    id: "c1",
    keywords: ["LINK"],
    matchAnyWord: false,
    wholeWordMatch: true,
    intentGateEnabled: false,
    intentDescription: null,
    intentThreshold: 0.7,
    ...overrides,
  };
}

const gated = campaign({
  id: "g1",
  matchAnyWord: true,
  intentGateEnabled: true,
  intentDescription: "a free furnace tune-up booking link",
});

describe("matchCampaigns — gate off", () => {
  it("is identical to matchKeywords for every fixture and never calls the provider", async () => {
    const provider = createFakeJudgmentProvider({});
    const fixtures = ["I want the LINK!", "linking is fun", "no thanks", "LİNK"];
    for (const text of fixtures) {
      const result = await matchCampaigns({ text, authorHandle: null, campaigns: [campaign()], provider });
      const expected = matchKeywords(text, ["LINK"], true);
      expect(result.get("c1")).toEqual({
        matched: expected.matched,
        matchedKeyword: expected.matchedKeyword,
        intentProbability: null,
        intentRejected: false,
        intentClosedReason: null,
      });
    }
    expect(provider.calls).toHaveLength(0);
  });

  it("matchAnyWord with the gate off fires on anything", async () => {
    const result = await matchCampaigns({
      text: "lovely", authorHandle: null,
      campaigns: [campaign({ matchAnyWord: true })], provider: null,
    });
    expect(result.get("c1")?.matched).toBe(true);
  });
});

describe("matchCampaigns — gate on", () => {
  it("passes and records the probability at or above threshold", async () => {
    const provider = createFakeJudgmentProvider({ g1: 0.83 });
    const result = await matchCampaigns({ text: "how much?", authorHandle: "sam", campaigns: [gated], provider });
    expect(result.get("g1")).toEqual({
      matched: true, matchedKeyword: null, intentProbability: 0.83,
      intentRejected: false, intentClosedReason: null,
    });
  });

  it("rejects below threshold and flags it as an intent rejection", async () => {
    const provider = createFakeJudgmentProvider({ g1: 0.2 });
    const result = await matchCampaigns({ text: "are you hiring", authorHandle: null, campaigns: [gated], provider });
    expect(result.get("g1")).toEqual({
      matched: false, matchedKeyword: null, intentProbability: 0.2,
      intentRejected: true, intentClosedReason: null,
    });
  });

  it("gates only keyword hits when keywords are set", async () => {
    const provider = createFakeJudgmentProvider({ k1: 0.9 });
    const withKeyword = campaign({ id: "k1", keywords: ["info"], intentGateEnabled: true, intentDescription: "pricing sheet" });
    const miss = await matchCampaigns({ text: "nice truck", authorHandle: null, campaigns: [withKeyword], provider });
    expect(miss.get("k1")?.matched).toBe(false);
    expect(provider.calls).toHaveLength(0);
    const hit = await matchCampaigns({ text: "info please", authorHandle: null, campaigns: [withKeyword], provider });
    expect(hit.get("k1")).toMatchObject({ matched: true, matchedKeyword: "info", intentProbability: 0.9 });
    expect(provider.calls).toHaveLength(1);
  });

  it("makes exactly one provider call for many gated campaigns", async () => {
    const provider = createFakeJudgmentProvider({ g1: 0.9, g2: 0.1, g3: 0.75 });
    const campaigns = [
      gated,
      { ...gated, id: "g2", intentDescription: "job postings" },
      { ...gated, id: "g3", intentDescription: "service-area map", intentThreshold: 0.75 },
    ];
    const result = await matchCampaigns({ text: "how much?", authorHandle: null, campaigns, provider });
    expect(provider.calls).toHaveLength(1);
    expect(Object.keys(provider.calls[0].questions).sort()).toEqual(["g1", "g2", "g3"]);
    expect(result.get("g1")?.matched).toBe(true);
    expect(result.get("g2")?.matched).toBe(false);
    expect(result.get("g3")?.matched).toBe(true);
  });

  it("propagates provider failure so nothing is sent", async () => {
    const provider = createFakeJudgmentProvider(() => {
      throw new IntentJudgmentUnavailableError("down");
    });
    await expect(
      matchCampaigns({ text: "how much?", authorHandle: null, campaigns: [gated], provider })
    ).rejects.toBeInstanceOf(IntentJudgmentUnavailableError);
  });

  it("is closed without a provider, with no call and a visible reason", async () => {
    const result = await matchCampaigns({ text: "how much?", authorHandle: null, campaigns: [gated], provider: null });
    expect(result.get("g1")).toEqual({
      matched: false, matchedKeyword: null, intentProbability: null,
      intentRejected: true, intentClosedReason: "no_provider",
    });
  });

  it("is closed for a gated campaign with no description, without calling the provider", async () => {
    const provider = createFakeJudgmentProvider({ g1: 0.99 });
    const result = await matchCampaigns({
      text: "how much?", authorHandle: null,
      campaigns: [{ ...gated, intentDescription: "   " }], provider,
    });
    expect(result.get("g1")).toMatchObject({ matched: false, intentRejected: true, intentClosedReason: "no_description" });
    expect(provider.calls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run**

Run: `npx vitest run __tests__/match-campaign.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `lib/matching/match-campaign.ts`:

```ts
import { matchKeywords } from "@/lib/utils/keyword-matcher";
import { gateIntents, type IntentCandidate } from "./intent-gate";
import type { JudgmentProvider } from "./judgment-provider";

/** The fields of an Automation row that matching reads. Prisma rows satisfy this directly. */
export interface MatchableCampaign {
  id: string;
  keywords: string[];
  matchAnyWord: boolean;
  wholeWordMatch: boolean;
  intentGateEnabled: boolean;
  intentDescription: string | null;
  intentThreshold: number;
}

/** Why a gated campaign was closed without asking the model. */
export type IntentClosedReason = "no_provider" | "no_description";

export interface CampaignMatch {
  matched: boolean;
  matchedKeyword: string | null;
  /** Set only when the gate actually ran for this campaign. */
  intentProbability: number | null;
  /** True when reach passed but the gate said no (or was closed). Drives the SKIPPED_NO_MATCH row. */
  intentRejected: boolean;
  intentClosedReason: IntentClosedReason | null;
}

const NOT_MATCHED: CampaignMatch = {
  matched: false,
  matchedKeyword: null,
  intentProbability: null,
  intentRejected: false,
  intentClosedReason: null,
};

/**
 * Reach, then meaning. Keyword matching decides which campaigns *consider*
 * the text; the intent gate decides, for those that ask for it, whether to
 * act. Every gated survivor goes into one provider call.
 *
 * Fails closed: no provider or no description rejects without a call; a
 * provider error propagates so the caller's job retries and nothing is sent.
 */
export async function matchCampaigns({
  text,
  authorHandle,
  campaigns,
  provider,
}: {
  text: string;
  authorHandle: string | null;
  campaigns: MatchableCampaign[];
  provider: JudgmentProvider | null;
}): Promise<Map<string, CampaignMatch>> {
  const results = new Map<string, CampaignMatch>();
  const candidates: IntentCandidate[] = [];
  const reachKeyword = new Map<string, string | null>();

  for (const campaign of campaigns) {
    const reach = campaign.matchAnyWord
      ? { matched: true, matchedKeyword: null }
      : matchKeywords(text, campaign.keywords, campaign.wholeWordMatch);

    if (!reach.matched) {
      results.set(campaign.id, NOT_MATCHED);
      continue;
    }

    if (!campaign.intentGateEnabled) {
      results.set(campaign.id, { ...NOT_MATCHED, matched: true, matchedKeyword: reach.matchedKeyword });
      continue;
    }

    const offer = campaign.intentDescription?.trim() ?? "";
    if (!offer) {
      results.set(campaign.id, { ...NOT_MATCHED, intentRejected: true, intentClosedReason: "no_description" });
      continue;
    }
    if (!provider) {
      results.set(campaign.id, { ...NOT_MATCHED, intentRejected: true, intentClosedReason: "no_provider" });
      continue;
    }

    reachKeyword.set(campaign.id, reach.matchedKeyword);
    candidates.push({ campaignId: campaign.id, offer, threshold: campaign.intentThreshold });
  }

  if (candidates.length > 0 && provider) {
    const verdicts = await gateIntents({ comment: { text, authorHandle }, candidates }, provider);
    for (const verdict of verdicts) {
      results.set(verdict.campaignId, {
        matched: verdict.outcome === "pass",
        matchedKeyword: reachKeyword.get(verdict.campaignId) ?? null,
        intentProbability: verdict.probability,
        intentRejected: verdict.outcome === "reject",
        intentClosedReason: null,
      });
    }
  }

  return results;
}
```

- [ ] **Step 4: Run**

Run: `npx vitest run __tests__/match-campaign.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/matching/match-campaign.ts __tests__/match-campaign.test.ts
git commit -m "feat(matching): matchCampaigns composes keyword reach with the intent gate

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Worker — comment path

**Files:**
- Modify: `lib/queue/dm-worker.ts` (imports ~line 41; `processComment` ~lines 266–360)
- Test: `__tests__/dm-worker.test.ts`

- [ ] **Step 1: Extend the test mocks** — in `__tests__/dm-worker.test.ts`:

In the `vi.hoisted` block, add to `mockPrisma.dmLog`: `findMany: vi.fn(),`. Add a new hoisted mock alongside the others: `mockGetJudgmentProvider: vi.fn(),` (and add it to the destructuring list).

After the existing `vi.mock("@/lib/utils/keyword-matcher", ...)` add:

```ts
vi.mock("@/lib/matching/judgment-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/matching/judgment-provider")>()),
  getJudgmentProvider: mockGetJudgmentProvider,
}));
```

Add to the `import` list near line 141: `import { createFakeJudgmentProvider } from "../lib/matching/judgment-provider";`

In `beforeEach`, after `mockPrisma.dmLog.findUnique.mockResolvedValue(null);` add:

```ts
  mockPrisma.dmLog.findMany.mockReset().mockResolvedValue([]);
  mockGetJudgmentProvider.mockReset().mockReturnValue(null);
```

Add the new fields to `mockAutomation` after `wholeWordMatch: true,`:

```ts
  intentGateEnabled: false,
  intentDescription: null,
  intentThreshold: 0.7,
```

- [ ] **Step 2: Write the failing tests** — new `describe` at the end of the file:

```ts
describe("DM Worker — intent gate on comments", () => {
  const gatedAutomation = {
    ...mockAutomation,
    id: "gated_1",
    keywords: [],
    matchAnyWord: true,
    intentGateEnabled: true,
    intentDescription: "a free furnace tune-up booking link",
    intentThreshold: 0.7,
  };

  it("sends when the gate passes and stores the probability", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([gatedAutomation]);
    mockGetJudgmentProvider.mockReturnValue(createFakeJudgmentProvider({ gated_1: 0.91 }));

    await getProcessor()(createMockJob());

    expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: "PENDING", intentProbability: 0.91 }),
      })
    );
  });

  it("writes SKIPPED_NO_MATCH with the probability and sends nothing when the gate rejects", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([gatedAutomation]);
    mockGetJudgmentProvider.mockReturnValue(createFakeJudgmentProvider({ gated_1: 0.12 }));

    await getProcessor()(createMockJob());

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith({
      where: { automationId_commentId: { automationId: "gated_1", commentId: "comment_555" } },
      create: expect.objectContaining({
        status: "SKIPPED_NO_MATCH",
        intentProbability: 0.12,
        commentText: "I want the LINK!",
      }),
      update: expect.objectContaining({ status: "SKIPPED_NO_MATCH", intentProbability: 0.12 }),
    });
  });

  it("is closed and visible when no TYPESAFE_API_KEY is configured", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([gatedAutomation]);
    mockGetJudgmentProvider.mockReturnValue(null);

    await getProcessor()(createMockJob());

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: "SKIPPED_NO_MATCH",
          intentProbability: null,
          errorMessage: "Intent gate closed: TYPESAFE_API_KEY is not set",
        }),
      })
    );
  });

  it("does not re-judge a comment this campaign already rejected", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([gatedAutomation]);
    mockPrisma.dmLog.findMany.mockResolvedValue([
      { automationId: "gated_1", status: "SKIPPED_NO_MATCH" },
    ]);
    const provider = createFakeJudgmentProvider({ gated_1: 0.99 });
    mockGetJudgmentProvider.mockReturnValue(provider);

    await getProcessor()(createMockJob());

    expect(provider.calls).toHaveLength(0);
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.upsert).not.toHaveBeenCalled();
  });

  it("fails the job (so BullMQ retries) and sends nothing when the provider is unavailable", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([gatedAutomation]);
    mockGetJudgmentProvider.mockReturnValue(
      createFakeJudgmentProvider(() => {
        throw new Error("TypeSafe request failed: 503");
      })
    );

    await expect(getProcessor()(createMockJob())).rejects.toThrow("503");
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.upsert).not.toHaveBeenCalled();
  });

  it("leaves a non-gated campaign untouched alongside a gated one", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([mockAutomation, gatedAutomation]);
    mockGetJudgmentProvider.mockReturnValue(createFakeJudgmentProvider({ gated_1: 0.1 }));

    await getProcessor()(createMockJob());

    // Keyword campaign sends; gated one is rejected. One private reply total.
    expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: Run**

Run: `npx vitest run __tests__/dm-worker.test.ts -t "intent gate on comments"`
Expected: FAIL — worker still calls `matchKeywords` directly; no `SKIPPED_NO_MATCH` writes.

- [ ] **Step 4: Implement in `lib/queue/dm-worker.ts`**

Replace the import `import { matchKeywords } from "@/lib/utils/keyword-matcher";` with:

```ts
import { matchCampaigns, type CampaignMatch } from "@/lib/matching/match-campaign";
import { getJudgmentProvider } from "@/lib/matching/judgment-provider";
```

Add this helper near `connectionScope`:

```ts
/** Log text for a comment the intent gate turned away, so the reason is visible in DM Logs. */
function intentRejectionMessage(match: CampaignMatch): string {
  if (match.intentClosedReason === "no_provider")
    return "Intent gate closed: TYPESAFE_API_KEY is not set";
  if (match.intentClosedReason === "no_description")
    return "Intent gate closed: campaign has no intent description";
  return `Intent gate rejected this comment (p=${match.intentProbability?.toFixed(2) ?? "?"})`;
}
```

In `processComment`, after the `automations` query and before `for (const automation of automations)`, insert:

```ts
  // Campaigns that already turned this comment away must not be judged again:
  // a retried job or a reconciler sweep would otherwise pay for the same
  // answer every time. Read those rows once for the whole comment.
  const priorRejections = new Set(
    (
      await prisma.dmLog.findMany({
        where: {
          commentId,
          automationId: { in: automations.map((a) => a.id) },
          status: "SKIPPED_NO_MATCH",
        },
        select: { automationId: true },
      })
    ).map((row) => row.automationId)
  );

  // Reach (keywords) and meaning (intent gate) for every campaign at once —
  // one provider call per comment however many gated campaigns are active.
  // A provider failure throws here, before any send, and the job retries.
  const matches = await matchCampaigns({
    text: commentText,
    authorHandle: commenterName ?? null,
    campaigns: automations.filter((a) => !priorRejections.has(a.id)),
    provider: getJudgmentProvider(),
  });
```

Replace the block

```ts
    // "Any word" campaigns fire on every comment; otherwise require a keyword hit.
    const matchResult = automation.matchAnyWord
      ? { matched: true, matchedKeyword: null }
      : matchKeywords(
          commentText,
          automation.keywords,
          automation.wholeWordMatch
        );

    if (!matchResult.matched) {
      continue;
    }
```

with:

```ts
    if (priorRejections.has(automation.id)) continue;

    const matchResult = matches.get(automation.id);
    if (!matchResult) continue;

    if (!matchResult.matched) {
      // A keyword miss writes nothing, as before. A gate rejection writes a
      // row: it is the data thresholds get tuned from, and it is what tells
      // the reconciler this comment is handled.
      if (matchResult.intentRejected) {
        const errorMessage = intentRejectionMessage(matchResult);
        await prisma.dmLog.upsert({
          where: { automationId_commentId: { automationId: automation.id, commentId } },
          create: {
            workspaceId: automation.workspaceId,
            automationId: automation.id,
            instagramAccountId: automation.instagramAccountId,
            commenterId,
            commenterName,
            commentText,
            commentId,
            matchedKeyword: matchResult.matchedKeyword,
            status: "SKIPPED_NO_MATCH",
            intentProbability: matchResult.intentProbability,
            errorMessage,
          },
          update: {
            status: "SKIPPED_NO_MATCH",
            intentProbability: matchResult.intentProbability,
            errorMessage,
          },
        });
      }
      continue;
    }
```

Then in the same loop, find the `PENDING` upsert (the one with `update: {}`) and add `intentProbability: matchResult.intentProbability,` to its `create` object after `matchedKeyword: matchResult.matchedKeyword,`.

Also add the short-circuit: directly after `if (existingLog?.status === "SKIPPED_PLAN_LIMIT") continue;` add:

```ts
    if (existingLog?.status === "SKIPPED_NO_MATCH") continue;
```

- [ ] **Step 5: Run the whole worker suite**

Run: `npx vitest run __tests__/dm-worker.test.ts`
Expected: PASS, including every pre-existing test. Note: the existing test `"should send a private reply for a matching comment"` asserts `mockMatchKeywords` was called with `("I want the LINK!", ["LINK","PRICE"], true)` — that still holds because `matchCampaigns` calls the (mocked) `matchKeywords` with the same arguments.

- [ ] **Step 6: Commit**

```bash
git add lib/queue/dm-worker.ts __tests__/dm-worker.test.ts
git commit -m "feat(worker): intent-gate comments, record rejections as SKIPPED_NO_MATCH

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Worker — inbound DM path

**Files:**
- Modify: `lib/queue/dm-worker.ts` (`processMessage`, ~lines 1262–1315)
- Test: `__tests__/dm-worker.test.ts`

- [ ] **Step 1: Failing test** — append a `describe`:

```ts
describe("DM Worker — intent gate on inbound DMs", () => {
  const gatedDmAutomation = {
    ...mockAutomation,
    id: "gated_dm",
    keywords: [],
    matchAnyWord: true,
    dmTriggerEnabled: true,
    intentGateEnabled: true,
    intentDescription: "a free furnace tune-up booking link",
    intentThreshold: 0.7,
  };
  const messageJob = {
    name: "process-message",
    data: {
      instagramAccountId: "ig_456",
      messageId: "mid_abc",
      messageText: "do you service Airdrie?",
      senderId: "sender_1",
    },
    id: "msg_job_1",
    attemptsMade: 0,
  };

  it("writes SKIPPED_NO_MATCH under the dm: dedupe id and sends nothing on reject", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([gatedDmAutomation]);
    mockGetJudgmentProvider.mockReturnValue(createFakeJudgmentProvider({ gated_dm: 0.3 }));

    await getProcessor()(messageJob);

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockSendDirectMessageWithLinkButton).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { automationId_commentId: { automationId: "gated_dm", commentId: "dm:mid_abc" } },
        create: expect.objectContaining({ status: "SKIPPED_NO_MATCH", intentProbability: 0.3 }),
      })
    );
  });

  it("skips a message this campaign already rejected without calling the provider", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([gatedDmAutomation]);
    mockPrisma.dmLog.findMany.mockResolvedValue([{ automationId: "gated_dm", status: "SKIPPED_NO_MATCH" }]);
    const provider = createFakeJudgmentProvider({ gated_dm: 0.99 });
    mockGetJudgmentProvider.mockReturnValue(provider);

    await getProcessor()(messageJob);

    expect(provider.calls).toHaveLength(0);
    expect(mockPrisma.dmLog.upsert).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run**

Run: `npx vitest run __tests__/dm-worker.test.ts -t "inbound DMs"`
Expected: FAIL.

- [ ] **Step 3: Implement** — in `processMessage`, after `const dedupeId = \`dm:${messageId}\`;` insert:

```ts
  const priorRejections = new Set(
    (
      await prisma.dmLog.findMany({
        where: {
          commentId: dedupeId,
          automationId: { in: automations.map((a) => a.id) },
          status: "SKIPPED_NO_MATCH",
        },
        select: { automationId: true },
      })
    ).map((row) => row.automationId)
  );

  const matches = await matchCampaigns({
    text: messageText,
    authorHandle: null,
    campaigns: automations.filter((a) => !priorRejections.has(a.id)),
    provider: getJudgmentProvider(),
  });
```

Replace

```ts
    const matchResult = automation.matchAnyWord
      ? { matched: true, matchedKeyword: null }
      : matchKeywords(
          messageText,
          automation.keywords,
          automation.wholeWordMatch
        );

    if (!matchResult.matched) continue;
```

with:

```ts
    if (priorRejections.has(automation.id)) continue;

    const matchResult = matches.get(automation.id);
    if (!matchResult) continue;

    if (!matchResult.matched) {
      if (matchResult.intentRejected) {
        const errorMessage = intentRejectionMessage(matchResult);
        await prisma.dmLog.upsert({
          where: { automationId_commentId: { automationId: automation.id, commentId: dedupeId } },
          create: {
            workspaceId: automation.workspaceId,
            automationId: automation.id,
            instagramAccountId: automation.instagramAccountId,
            commenterId: senderId,
            commentText: messageText,
            commentId: dedupeId,
            matchedKeyword: matchResult.matchedKeyword,
            status: "SKIPPED_NO_MATCH",
            intentProbability: matchResult.intentProbability,
            errorMessage,
          },
          update: {
            status: "SKIPPED_NO_MATCH",
            intentProbability: matchResult.intentProbability,
            errorMessage,
          },
        });
      }
      continue;
    }
```

Extend the existing short-circuit condition to include the new status:

```ts
    if (
      existingLog?.status === "SENT" ||
      existingLog?.status === "SKIPPED_PLAN_LIMIT" ||
      existingLog?.status === "SKIPPED_NO_MATCH" ||
      existingLog?.dmDeliveryUnconfirmed
    ) {
      continue;
    }
```

Add `intentProbability: matchResult.intentProbability,` to `logBase` after `matchedKeyword`.

- [ ] **Step 4: Run**

Run: `npx vitest run __tests__/dm-worker.test.ts && npm run typecheck`
Expected: PASS; typecheck clean; `matchKeywords` is no longer imported anywhere in `dm-worker.ts` (grep to confirm — `lint` will flag an unused import otherwise).

- [ ] **Step 5: Commit**

```bash
git add lib/queue/dm-worker.ts __tests__/dm-worker.test.ts
git commit -m "feat(worker): intent-gate inbound DM triggers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Reconciler treats rejections as handled

**Files:**
- Modify: `lib/polling/comment-reconciler.ts` (`handledSet`, ~lines 251–258)
- Test: `__tests__/comment-reconciler.test.ts`

- [ ] **Step 1: Failing test** — inside the existing `describe("comment polling does not recreate unsafe sends")`, read how that describe sets up `mockPrisma.automation.findMany`, `readComments` and `queueAdd`, then add a test in the same style. The essential assertions:

```ts
  it("never re-enqueues a comment the intent gate already rejected, even with a public reply on", async () => {
    // Arrange exactly as the neighbouring tests do (one active campaign with
    // publicReplyEnabled: true, one comment from a stranger returned by
    // readComments), then:
    mockPrisma.dmLog.findMany.mockResolvedValue([
      {
        commentId: "c_rejected",
        status: "SKIPPED_NO_MATCH",
        attempts: 0,
        errorMessage: "Intent gate rejected this comment (p=0.12)",
        dmDeliveryUnconfirmed: false,
        publicReplySentAt: null,
        publicReplyDeliveryUnconfirmed: false,
      },
    ]);

    await reconcileComments();

    expect(queueAdd).not.toHaveBeenCalled();
  });
```

Use the comment id `c_rejected` in the `readComments` fixture for this test.

- [ ] **Step 2: Run**

Run: `npx vitest run __tests__/comment-reconciler.test.ts -t "intent gate already rejected"`
Expected: FAIL — `queueAdd` was called (a `SKIPPED_NO_MATCH` row with `publicReplySentAt: null` is not yet "handled").

- [ ] **Step 3: Implement** — replace the `handledSet` computation with:

```ts
    const handledSet = new Set(logs.filter((log) => {
      // The intent gate turned this comment away: no DM and no public reply
      // will ever be owed, so it is fully handled whatever the campaign posts.
      if (log.status === "SKIPPED_NO_MATCH") return true;
      const dmStopped = log.status === "SENT" || log.status === "SKIPPED_PLAN_LIMIT" ||
        log.dmDeliveryUnconfirmed || log.attempts >= MAX_COMMENT_SEND_ATTEMPTS ||
        (log.status === "FAILED" && hasLegacyUnconfirmedDelivery(log.errorMessage));
      const replyStopped = !automation.publicReplyEnabled ||
        log.publicReplySentAt || log.publicReplyDeliveryUnconfirmed;
      return dmStopped && replyStopped;
    }).map((log) => log.commentId));
```

- [ ] **Step 4: Run**

Run: `npx vitest run __tests__/comment-reconciler.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/polling/comment-reconciler.ts __tests__/comment-reconciler.test.ts
git commit -m "fix(reconciler): an intent-gate rejection is a handled comment

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Boot-time configuration warning

**Files:**
- Modify: `worker/dm-worker.ts`

No unit test: this file is the composition root and is not imported by tests. Verified by running the worker.

- [ ] **Step 1: Implement** — add imports:

```ts
import { prisma } from "@/lib/db/client";
import { getJudgmentProvider } from "@/lib/matching/judgment-provider";
```

After `console.log("[DM Worker] Started");` add:

```ts
// Gated campaigns with no TypeSafe key are closed, not broken: nothing sends
// and nothing crashes. Say so once at boot so the silence is explainable.
async function warnIfIntentGateUnconfigured() {
  if (getJudgmentProvider()) return;
  try {
    const gated = await prisma.automation.count({
      where: { isActive: true, intentGateEnabled: true },
    });
    if (gated === 0) return;
    const message = `${gated} active campaign(s) use the intent gate but TYPESAFE_API_KEY is not set; those campaigns will not send`;
    console.warn(`[DM Worker] ${message}`);
    await prisma.operationalEvent.create({
      data: { source: "WORKER", level: "WARNING", message, payload: { gatedCampaigns: gated } },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[DM Worker] Intent gate configuration check failed:", message);
  }
}
void warnIfIntentGateUnconfigured();
```

- [ ] **Step 2: Verify by running** (Postgres and Redis up, no key set):

Run: `npm run worker` — wait for `[DM Worker] Started`, then Ctrl+C.
Expected: no warning (no gated campaigns exist yet). Typecheck clean: `npm run typecheck`.

- [ ] **Step 3: Commit**

```bash
git add worker/dm-worker.ts
git commit -m "feat(worker): warn at boot when gated campaigns have no TypeSafe key

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: API — accept and validate the fields

**Files:**
- Modify: `app/api/automations/route.ts` (`createAutomationSchema` ~line 22, `updateAutomationSchema` ~line 87, create `data` ~line 370, update consistency block ~line 489)
- Modify: `app/api/automations/import/route.ts` (`campaignSchema` ~line 12, create `data` ~line 91)

There is no existing API route test harness; these are covered by `npm run typecheck` and the manual UI check in Task 10.

- [ ] **Step 1: Create schema** — in `createAutomationSchema`, after `wholeWordMatch: z.boolean().optional().default(true),` add:

```ts
    intentGateEnabled: z.boolean().optional().default(false),
    intentDescription: z.string().max(500).optional().nullable(),
    intentThreshold: z.number().min(0.5).max(0.95).optional().default(0.7),
```

After the last `.refine(...)` in that chain add:

```ts
  // The gate has nothing to judge against without a description.
  .refine((d) => !d.intentGateEnabled || Boolean(d.intentDescription?.trim()), {
    message: "Describe what the campaign offers, or turn off the intent check",
    path: ["intentDescription"],
  });
```

(Remove the `;` from the previous last refine so the chain continues.)

- [ ] **Step 2: Update schema** — in `updateAutomationSchema` after `wholeWordMatch: z.boolean().optional(),` add:

```ts
  intentGateEnabled: z.boolean().optional(),
  intentDescription: z.string().max(500).optional().nullable(),
  intentThreshold: z.number().min(0.5).max(0.95).optional(),
```

- [ ] **Step 3: Create mapping** — in the `prisma.automation.create({ data: {...} })` after `wholeWordMatch: parsed.data.wholeWordMatch,` add:

```ts
      intentGateEnabled: parsed.data.intentGateEnabled,
      intentDescription: parsed.data.intentGateEnabled
        ? parsed.data.intentDescription?.trim() || null
        : null,
      intentThreshold: parsed.data.intentThreshold,
```

- [ ] **Step 4: Update consistency** — in the "Keep dependent fields consistent" block add:

```ts
  if (automationData.intentGateEnabled === false) automationData.intentDescription = null;
  if (
    automationData.intentGateEnabled === true &&
    automationData.intentDescription !== undefined &&
    !automationData.intentDescription?.trim()
  ) {
    return NextResponse.json(
      { success: false, error: "Describe what the campaign offers, or turn off the intent check" },
      { status: 400 }
    );
  }
```

Match the error-response shape the surrounding handler already uses for validation failures (look at how `parsed.success === false` is returned a few lines above and mirror it).

- [ ] **Step 5: Import route** — in `campaignSchema` after `wholeWordMatch` add:

```ts
  intentGateEnabled: z.boolean().optional().default(false),
  intentDescription: z.string().max(500).optional().nullable(),
  intentThreshold: z.number().min(0.5).max(0.95).optional().default(0.7),
```

and turn the `z.object({...})` into `z.object({...}).refine((d) => !d.intentGateEnabled || Boolean(d.intentDescription?.trim()), { message: "Describe what the campaign offers, or turn off the intent check", path: ["intentDescription"] })`.

In its `prisma.automation.create({ data })` after `wholeWordMatch: campaign.wholeWordMatch,` add:

```ts
        intentGateEnabled: campaign.intentGateEnabled,
        intentDescription: campaign.intentGateEnabled
          ? campaign.intentDescription?.trim() || null
          : null,
        intentThreshold: campaign.intentThreshold,
```

- [ ] **Step 6: Verify**

Run: `npm run typecheck && npm run lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add app/api/automations/route.ts app/api/automations/import/route.ts
git commit -m "feat(api): accept intent gate fields on create, update and import

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Campaign builder UI + translations

**Files:**
- Modify: `components/campaign-builder.tsx` (`LoadedCampaign` ~line 31; state hooks; load block ~line 261; validation ~line 395; payload ~line 409; UI after the `any word` Radio ~line 725)
- Modify: `lib/i18n/zh-TW.json`

`MessageKey` is `keyof typeof zhTW`, so every new `t("...")` string **must** have an entry in `zh-TW.json` or `typecheck` fails. Keep the file's alphabetical key order.

- [ ] **Step 1: Translations** — add to `lib/i18n/zh-TW.json`:

```json
  "A free furnace tune-up booking link for Calgary homeowners": "例如：提供卡加利屋主免費暖爐保養預約連結",
  "Advanced: confidence threshold": "進階：信心門檻",
  "Describe what the campaign offers, or turn off the intent check.": "請描述活動提供的內容，或關閉意圖檢查。",
  "Describe what this campaign offers. Before any DM is sent, an AI judgment checks whether the comment actually asks for it. Needs TYPESAFE_API_KEY on the server.": "描述這個活動提供的內容。傳送私訊前，AI 會判斷留言是否確實在索取。伺服器需設定 TYPESAFE_API_KEY。",
  "intent {percent}%": "意圖 {percent}%",
  "only reply when the comment actually asks for it": "只在留言確實在索取時才回覆",
```

- [ ] **Step 2: `LoadedCampaign`** — add after `isActive: boolean;`:

```ts
  intentGateEnabled?: boolean;
  intentDescription?: string | null;
  intentThreshold?: number | null;
```

- [ ] **Step 3: State** — next to the other `useState` hooks (find `const [matchMode, setMatchMode]`), add:

```ts
  const [intentGateEnabled, setIntentGateEnabled] = useState(false);
  const [intentDescription, setIntentDescription] = useState("");
  const [intentThreshold, setIntentThreshold] = useState(0.7);
```

- [ ] **Step 4: Load** — after `setKeywordText(c.keywords.join(", "));` add:

```ts
        setIntentGateEnabled(c.intentGateEnabled ?? false);
        setIntentDescription(c.intentDescription ?? "");
        setIntentThreshold(c.intentThreshold ?? 0.7);
```

- [ ] **Step 5: Validation** — after the `matchMode === "specific" && keywords.length === 0` check add:

```ts
    if (intentGateEnabled && !intentDescription.trim())
      return setError(t("Describe what the campaign offers, or turn off the intent check."));
```

- [ ] **Step 6: Payload** — after `keywords: matchMode === "any" ? [] : keywords,` add:

```ts
      intentGateEnabled,
      intentDescription: intentGateEnabled ? intentDescription.trim() : null,
      intentThreshold,
```

- [ ] **Step 7: UI** — directly after the closing `</Radio>` of the `{t("any word")}` radio, before the "also reply when someone DMs" block, add:

```tsx
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
            <span className="text-sm text-foreground">
              {t("only reply when the comment actually asks for it")}
            </span>
            <Toggle
              on={intentGateEnabled}
              onToggle={() => setIntentGateEnabled(!intentGateEnabled)}
            />
          </div>
          {intentGateEnabled && (
            <div className="space-y-2">
              <textarea
                value={intentDescription}
                onChange={(e) => setIntentDescription(e.target.value)}
                rows={2}
                maxLength={500}
                placeholder={t("A free furnace tune-up booking link for Calgary homeowners")}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none"
              />
              <p className="text-xs text-muted">
                {t(
                  "Describe what this campaign offers. Before any DM is sent, an AI judgment checks whether the comment actually asks for it. Needs TYPESAFE_API_KEY on the server."
                )}
              </p>
              <details>
                <summary className="cursor-pointer text-xs text-muted">
                  {t("Advanced: confidence threshold")}
                </summary>
                <div className="mt-2 flex items-center gap-3">
                  <input
                    type="range"
                    min={0.5}
                    max={0.95}
                    step={0.05}
                    value={intentThreshold}
                    onChange={(e) => setIntentThreshold(Number(e.target.value))}
                    className="flex-1"
                  />
                  <span className="w-12 text-right text-sm text-foreground">
                    {Math.round(intentThreshold * 100)}%
                  </span>
                </div>
              </details>
            </div>
          )}
```

- [ ] **Step 8: Verify in the browser**

Run: `npm run typecheck && npm run lint`, then `npm run dev`. Sign-in needs email delivery; if `RESEND_API_KEY` is a placeholder, read the magic link from the dev-server console output (Auth.js logs it when the provider fails) or set `EMAIL_SERVER` to a local SMTP catcher. Create a campaign with the gate on and an empty description → the inline error appears. Fill the description, save, reopen → toggle, text and threshold persist. Switch language to 繁體中文 → strings translated.

- [ ] **Step 9: Commit**

```bash
git add components/campaign-builder.tsx lib/i18n/zh-TW.json
git commit -m "feat(ui): intent gate controls in the campaign builder, en + zh-TW

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Logs show the probability

**Files:**
- Modify: `app/(dashboard)/logs/page.tsx` (`DmLog` interface ~line 14; comment cell ~line 177)

- [ ] **Step 1: Type** — add to `interface DmLog` after `errorMessage: string | null;`:

```ts
  intentProbability: number | null;
```

- [ ] **Step 2: Render** — the page already calls `useI18n()` for `locale`; make sure `t` is destructured too (`const { t, locale } = useI18n();`). Replace the comment cell:

```tsx
                    <td className="px-4 py-4 max-w-[200px] sm:px-6">
                      <span className="text-muted truncate block">{log.commentText}</span>
                      {log.intentProbability != null && (
                        <span className="block text-xs text-muted">
                          {t("intent {percent}%", {
                            percent: Math.round(log.intentProbability * 100),
                          })}
                        </span>
                      )}
                    </td>
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm run lint`. In the dev app, DM Logs renders; rows without a probability are unchanged.

- [ ] **Step 4: Commit**

```bash
git add "app/(dashboard)/logs/page.tsx"
git commit -m "feat(logs): show intent probability on gated rows

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Docs, env example, live fixture test

**Files:**
- Modify: `.env.example`
- Modify: `docs/setup.md` (after the `## Environment variables` section's table, before `## Connect through Zernio`)
- Create: `__tests__/intent-gate.live.test.ts`

- [ ] **Step 1: `.env.example`** — append:

```
# Optional: intent gate. When set, a campaign can require that a comment
# actually asks for what it offers (judged by TypeSafe's Jev model) before any
# DM is sent. Without it, gated campaigns are closed and nothing else changes.
# Paid per call — see docs/setup.md.
# TYPESAFE_API_KEY=ts_...
```

- [ ] **Step 2: `docs/setup.md`** — insert before `## Connect through Zernio`:

```markdown
## Optional: the intent gate

Keyword matching decides which comments a campaign *considers*. The intent gate decides whether the comment actually *asks for* what the campaign offers. Turn it on per campaign under "And this comment has" → "only reply when the comment actually asks for it", and describe the offer in plain words ("a free furnace tune-up booking link for Calgary homeowners"). Combined with "any word", a campaign then reaches every comment on the post and DMs only the people who asked; combined with keywords, it stops a noisy word like "info" from firing on praise or complaints.

It needs `TYPESAFE_API_KEY` on the **worker** (get one at typesafe.ai). One request is made per comment however many gated campaigns are active, and each rejected comment is logged once as "No match" with its probability and never re-judged. Without the key, gated campaigns send nothing and the worker records one warning at boot; every other campaign is unaffected. The gate fails closed on any provider error — the job retries, nothing is sent.
```

- [ ] **Step 3: Live fixture test** — `__tests__/intent-gate.live.test.ts`:

```ts
/**
 * Runs against the real TypeSafe API. Paid. Skipped unless both are set:
 *   TYPESAFE_API_KEY=...  TYPESAFE_LIVE_TEST=1  npx vitest run __tests__/intent-gate.live.test.ts
 */
import { describe, expect, it } from "vitest";
import { matchCampaigns } from "../lib/matching/match-campaign";
import { getJudgmentProvider } from "../lib/matching/judgment-provider";

const live = process.env.TYPESAFE_LIVE_TEST === "1" && Boolean(process.env.TYPESAFE_API_KEY);

describe.skipIf(!live)("intent gate — live Jev", () => {
  const tuneUp = {
    id: "live_tuneup",
    keywords: [],
    matchAnyWord: true,
    wholeWordMatch: true,
    intentGateEnabled: true,
    intentDescription: "a free furnace tune-up booking link for Calgary homeowners",
    intentThreshold: 0.7,
  };

  it("passes a clear request and rejects a job inquiry, in one call each", async () => {
    const provider = getJudgmentProvider();
    expect(provider).not.toBeNull();

    const ask = await matchCampaigns({ text: "how do I book the free tune up?", authorHandle: null, campaigns: [tuneUp], provider });
    const hire = await matchCampaigns({ text: "are you guys hiring apprentices?", authorHandle: null, campaigns: [tuneUp], provider });

    expect(ask.get("live_tuneup")?.matched).toBe(true);
    expect(hire.get("live_tuneup")?.matched).toBe(false);
    expect(hire.get("live_tuneup")?.intentProbability).toBeLessThan(0.5);
  }, 30_000);
});
```

- [ ] **Step 4: Confirm it is skipped by default**

Run: `npx vitest run __tests__/intent-gate.live.test.ts`
Expected: 1 skipped, 0 failed.

- [ ] **Step 5: Commit**

```bash
git add .env.example docs/setup.md __tests__/intent-gate.live.test.ts
git commit -m "docs: intent gate setup, env example, opt-in live fixture test

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: Full verification

- [ ] **Step 1: The CONTRIBUTING gate**

```bash
npm run typecheck && npm run lint && npm test && npm run build
```

Expected: all four clean. Fix anything that fails in place, commit as `fix: ...`.

- [ ] **Step 2: Behaviour check with no key** — `npm run worker` with a saved gated campaign: boot logs the warning and an `OperationalEvent` row is created (check the Health/diagnostics page or the table).

- [ ] **Step 3: The one paid call** — **stop and ask the account owner** before this step; no paid Jev call has been made from this workspace. Once approved, set `TYPESAFE_API_KEY` and `TYPESAFE_LIVE_TEST=1` in the shell from your own secret store, without printing the key, then run:

```bash
npx vitest run __tests__/intent-gate.live.test.ts
```

Expected: 1 passed. Record the two probabilities it observed in the PR description. Never echo the key.

- [ ] **Step 4: Hand off** — `superpowers:finishing-a-development-branch`. Pushing the branch needs `gh` authenticated as the account that owns the fork.

---

## Self-review

**Spec coverage.** Boundary/three modules → Tasks 2–4. Hoisted single call → Task 4 (test "exactly one provider call") and Tasks 5–6 (call before loop). Three `Automation` fields + `DmLog.intentProbability`, no enum, defaults → Task 1. Composition table (keywords/anyWord × gate) → Task 4 tests. Empty-description rejected at save → Task 9; closed at worker → Task 4. Noul question shape, `comment.text` / `campaigns.<id>.offer` references, criteria, no maybe-band → Task 3. Probability on `DmLog` → Tasks 5–6. Caption excluded → nothing to build. Rejection writes `SKIPPED_NO_MATCH`, reconciler handled test, short-circuits → Tasks 5–7. Fail closed / throw before send / BullMQ retry / no-key closed with `OperationalEvent` / `getTypeSafeApiKey` returns null → Tasks 1, 4, 5, 8. Surface (toggle, textarea placeholder, advanced threshold, logs probability, both languages, `.env.example`, `setup.md`) → Tasks 10–12. Testing list → Tasks 1–7, 12. Release → Task 13.

**Placeholders.** Task 7 step 1 asks the engineer to mirror neighbouring test setup rather than reproducing it verbatim — the fixture shape for `readComments` lives in that file and is stable; the assertion and the `dmLog.findMany` row are given in full. Task 9 step 4 likewise points at the handler's existing 400 shape. Both are reads of adjacent code, not design gaps.

**Type consistency.** `IntentRequest`, `IntentProbabilities`, `JudgmentProvider`, `IntentJudgmentUnavailableError`, `createFakeJudgmentProvider` (returns `FakeJudgmentProvider` with `calls`), `getJudgmentProvider`, `resetJudgmentProviderForTests` — Task 2, used unchanged in 3–6, 8, 12. `IntentCandidate {campaignId, offer, threshold}`, `gateIntents(input, provider)` → `IntentVerdict {campaignId, outcome, probability}` — Task 3, consumed in 4. `MatchableCampaign`, `CampaignMatch {matched, matchedKeyword, intentProbability, intentRejected, intentClosedReason}`, `matchCampaigns({text, authorHandle, campaigns, provider})` → `Map` — Task 4, consumed in 5–6 and 12. `intentRejectionMessage(match: CampaignMatch)` — Task 5, reused in 6. Column names `intentGateEnabled` / `intentDescription` / `intentThreshold` / `intentProbability` identical across schema, SQL, API, UI, tests.
