import {
  AuthenticationError,
  BadRequestError,
  NotFoundError,
  PermissionDeniedError,
  TypeSafeClient,
  UnprocessableEntityError,
  type EntryType,
  type NoulQuestion,
} from "@typesafe-ai/sdk";
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

/**
 * Thrown when the provider refused the request itself. That is configuration
 * or input, not weather: retrying the same request cannot help, so the gate
 * closes for the affected campaigns and the job completes instead of retrying.
 *
 * `affectsAllRequests` is true when the refusal is about the key or account
 * (401, 403), so every other request would be refused too; false when only
 * this request was refused (400, 404, 422), for example one odd comment or a
 * mistyped model name.
 */
export class IntentJudgmentRejectedError extends Error {
  readonly affectsAllRequests: boolean;

  constructor(message: string, options?: { cause?: unknown; affectsAllRequests?: boolean }) {
    super(message, options);
    this.name = "IntentJudgmentRejectedError";
    this.affectsAllRequests = options?.affectsAllRequests ?? true;
  }
}

/**
 * How long a provider whose key or account was refused keeps refusing locally
 * without a call. Closures are re-enqueued by the reconciler every five minutes and must
 * stay free; without this each sweep would resend a doomed request per comment.
 */
export const REJECTION_COOLDOWN_MS = 10 * 60 * 1000;

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

/**
 * The key or account was refused: every request would fail the same way, so
 * these pause the gate for everyone (see REJECTION_COOLDOWN_MS).
 */
const ACCOUNT_REFUSALS = [AuthenticationError, PermissionDeniedError] as const;

/**
 * Only this request was refused (malformed input, one odd comment, a model
 * name that does not exist). Retrying it cannot help, but other comments may
 * well succeed, so these close the gate for this comment only.
 */
const REQUEST_REFUSALS = [BadRequestError, UnprocessableEntityError, NotFoundError] as const;

const isAny = (error: unknown, classes: readonly (abstract new (...args: never[]) => unknown)[]) =>
  classes.some((cls) => error instanceof cls);

export class TypeSafeJudgmentProvider implements JudgmentProvider {
  private readonly now: () => number;
  private rejectedAt: number | null = null;
  private rejectedMessage = "";
  private rejectionLogged = false;

  constructor(
    private readonly client: SystemOneClient,
    { now = Date.now }: { now?: () => number } = {}
  ) {
    this.now = now;
  }

  async judgeIntents(request: IntentRequest): Promise<IntentProbabilities> {
    if (this.rejectedAt !== null && this.now() - this.rejectedAt < REJECTION_COOLDOWN_MS) {
      throw new IntentJudgmentRejectedError(this.rejectedMessage, { affectsAllRequests: true });
    }

    let result: Awaited<ReturnType<SystemOneClient["systemOne"]>>;
    try {
      result = await this.client.systemOne(request);
    } catch (error) {
      // SDK error messages carry the HTTP status and the response body's
      // message, never request headers, so they are safe to log.
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : "unknown error";
      if (isAny(error, ACCOUNT_REFUSALS)) {
        const message = `TypeSafe rejected the request (${detail})`;
        this.rejectedAt = this.now();
        this.rejectedMessage = message;
        if (!this.rejectionLogged) {
          this.rejectionLogged = true;
          console.error(
            "[Intent gate] TypeSafe rejected the request; gated campaigns are closed until this is fixed:",
            message
          );
        }
        throw new IntentJudgmentRejectedError(message, { cause: error, affectsAllRequests: true });
      }
      if (isAny(error, REQUEST_REFUSALS)) {
        throw new IntentJudgmentRejectedError(`TypeSafe could not process this request (${detail})`, {
          cause: error,
          affectsAllRequests: false,
        });
      }
      throw new IntentJudgmentUnavailableError(`TypeSafe request failed: ${detail}`, {
        cause: error,
      });
    }
    this.rejectedAt = null;

    const out: IntentProbabilities = {};
    for (const id of Object.keys(request.questions)) {
      const answer = result.answers[id];
      if (!answer || typeof answer.noul !== "number" || Number.isNaN(answer.noul)) {
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
  // Construction can throw (malformed key, SDK config error). That must not
  // escape into every job, including those of campaigns that never enabled the
  // gate: close the gate instead, exactly as if no key were configured. Log the
  // message only, never the key, the error object, its cause or the config.
  try {
    // One attempt with a short timeout: BullMQ and the reconciler already own
    // retries. Stacking the SDK's on top multiplied every failure and held one
    // of the worker's concurrency slots through the whole backoff, delaying
    // unrelated jobs.
    const client = new TypeSafeClient({ apiKey, timeout: 5000, retry: { maxRetries: 0 } });
    cached = new TypeSafeJudgmentProvider({
      systemOne: (request) => client.systemOne(request),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    console.error("[Intent gate] TypeSafe client could not be created:", message);
    cached = null;
  }
  return cached;
}

export function resetJudgmentProviderForTests(): void {
  cached = undefined;
}
