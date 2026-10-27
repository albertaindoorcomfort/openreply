import { afterEach, describe, expect, it, vi } from "vitest";

const sdkState = vi.hoisted(() => ({
  throwOnConstruct: false,
  constructorArgs: [] as unknown[][],
}));
vi.mock("@typesafe-ai/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@typesafe-ai/sdk")>();
  return {
    ...actual,
    TypeSafeClient: class extends actual.TypeSafeClient {
      constructor(...args: ConstructorParameters<typeof actual.TypeSafeClient>) {
        sdkState.constructorArgs.push(args);
        if (sdkState.throwOnConstruct) throw new Error("bad client config");
        super(...args);
      }
    },
  };
});
import {
  APIConnectionError,
  APITimeoutError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  UnprocessableEntityError,
} from "@typesafe-ai/sdk";
import {
  createFakeJudgmentProvider,
  getJudgmentProvider,
  IntentJudgmentRejectedError,
  IntentJudgmentUnavailableError,
  REJECTION_COOLDOWN_MS,
  resetJudgmentProviderForTests,
  TypeSafeJudgmentProvider,
  type IntentRequest,
} from "../lib/matching/judgment-provider";

const request: IntentRequest = {
  state: { comment: { text: "how much?", authorHandle: "sam" }, campaigns: { a1: { offer: "tune-up" } } },
  questions: { a1: { type: "noul", instructions: "q", criteria: { true: "y", false: "n" } } },
};

afterEach(() => {
  sdkState.throwOnConstruct = false;
  sdkState.constructorArgs = [];
  vi.restoreAllMocks();
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
    await expect(provider.judgeIntents(request)).rejects.toMatchObject({
      cause: expect.objectContaining({ message: "503 upstream" }),
    });
  });

  it("treats a missing answer as unavailable rather than a silent zero", async () => {
    const systemOne = vi.fn().mockResolvedValue({ answers: {} });
    const provider = new TypeSafeJudgmentProvider({ systemOne });
    await expect(provider.judgeIntents(request)).rejects.toBeInstanceOf(
      IntentJudgmentUnavailableError
    );
  });

  it("treats a partial answer set as unavailable rather than a silent zero", async () => {
    const multiRequest: IntentRequest = {
      state: request.state,
      questions: {
        a1: { type: "noul", instructions: "q1", criteria: { true: "y", false: "n" } },
        a2: { type: "noul", instructions: "q2", criteria: { true: "y", false: "n" } },
      },
    };
    const systemOne = vi.fn().mockResolvedValue({
      answers: { a1: { type: "noul", noul: 0.5 } },
    });
    const provider = new TypeSafeJudgmentProvider({ systemOne });
    await expect(provider.judgeIntents(multiRequest)).rejects.toBeInstanceOf(
      IntentJudgmentUnavailableError
    );
  });

  it("treats a NaN noul as unavailable rather than a silent zero", async () => {
    const systemOne = vi.fn().mockResolvedValue({
      answers: { a1: { type: "noul", noul: Number.NaN } },
    });
    const provider = new TypeSafeJudgmentProvider({ systemOne });
    await expect(provider.judgeIntents(request)).rejects.toBeInstanceOf(
      IntentJudgmentUnavailableError
    );
  });
});

describe("TypeSafe provider — error classification", () => {
  const headers = () => new Headers({ authorization: "Bearer ts_secret_value" });
  const body = { error: { message: "nope" } };

  const rejected: Array<[string, () => Error]> = [
    ["401 authentication", () => new AuthenticationError(401, body, headers())],
    ["403 permission denied", () => new PermissionDeniedError(403, body, headers())],
    ["400 bad request", () => new BadRequestError(400, body, headers())],
    ["404 not found", () => new NotFoundError(404, body, headers())],
    ["422 unprocessable", () => new UnprocessableEntityError(422, body, headers())],
  ];
  const unavailable: Array<[string, () => Error]> = [
    ["429 rate limit", () => new RateLimitError(429, body, headers())],
    ["503 server error", () => new InternalServerError(503, body, headers())],
    ["connection failure", () => new APIConnectionError("socket hang up")],
    ["timeout", () => new APITimeoutError(5000)],
    ["plain Error", () => new Error("something odd")],
  ];

  function quiet() {
    vi.spyOn(console, "error").mockImplementation(() => {});
  }

  it.each(rejected)("treats %s as a rejected request, preserving the cause", async (_label, make) => {
    quiet();
    const error = make();
    const provider = new TypeSafeJudgmentProvider({ systemOne: vi.fn().mockRejectedValue(error) });
    const failure = await provider.judgeIntents(request).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(IntentJudgmentRejectedError);
    expect(failure).not.toBeInstanceOf(IntentJudgmentUnavailableError);
    expect((failure as Error).cause).toBe(error);
    expect((failure as Error).message).toMatch(/\b4\d\d\b/);
    expect((failure as Error).message).not.toContain("ts_secret_value");
  });

  it.each(unavailable)("treats %s as unavailable, preserving the cause", async (_label, make) => {
    const error = make();
    const provider = new TypeSafeJudgmentProvider({ systemOne: vi.fn().mockRejectedValue(error) });
    const failure = await provider.judgeIntents(request).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(IntentJudgmentUnavailableError);
    expect(failure).not.toBeInstanceOf(IntentJudgmentRejectedError);
    expect((failure as Error).cause).toBe(error);
    expect((failure as Error).message).not.toContain("ts_secret_value");
  });

  it("stops calling the provider for the cooldown after a rejection, then tries again", async () => {
    quiet();
    let clock = 1_000_000;
    const systemOne = vi.fn().mockRejectedValue(new AuthenticationError(401, body, headers()));
    const provider = new TypeSafeJudgmentProvider({ systemOne }, { now: () => clock });

    await expect(provider.judgeIntents(request)).rejects.toBeInstanceOf(IntentJudgmentRejectedError);
    clock += REJECTION_COOLDOWN_MS - 1;
    await expect(provider.judgeIntents(request)).rejects.toBeInstanceOf(IntentJudgmentRejectedError);
    expect(systemOne).toHaveBeenCalledTimes(1);

    clock += 1;
    systemOne.mockResolvedValue({ answers: { a1: { type: "noul", noul: 0.6 } } });
    await expect(provider.judgeIntents(request)).resolves.toEqual({ a1: 0.6 });
    expect(systemOne).toHaveBeenCalledTimes(2);
  });

  const perRequest: Array<[string, () => Error]> = [
    ["400 bad request", () => new BadRequestError(400, body, headers())],
    ["422 unprocessable", () => new UnprocessableEntityError(422, body, headers())],
    ["404 not found", () => new NotFoundError(404, body, headers())],
  ];

  it.each(perRequest)(
    "refuses only this request on %s: no cooldown, no closed-gate log",
    async (_label, make) => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const systemOne = vi.fn().mockRejectedValueOnce(make());
      const provider = new TypeSafeJudgmentProvider({ systemOne }, { now: () => 0 });

      const failure = await provider.judgeIntents(request).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(IntentJudgmentRejectedError);
      expect((failure as IntentJudgmentRejectedError).affectsAllRequests).toBe(false);

      systemOne.mockResolvedValue({ answers: { a1: { type: "noul", noul: 0.4 } } });
      await expect(provider.judgeIntents(request)).resolves.toEqual({ a1: 0.4 });
      expect(systemOne).toHaveBeenCalledTimes(2);
      expect(errorSpy).not.toHaveBeenCalled();
    }
  );

  const accountWide: Array<[string, () => Error]> = [
    ["401 authentication", () => new AuthenticationError(401, body, headers())],
    ["403 permission denied", () => new PermissionDeniedError(403, body, headers())],
  ];

  it.each(accountWide)("pauses every request for the cooldown on %s", async (_label, make) => {
    quiet();
    const systemOne = vi.fn().mockRejectedValue(make());
    const provider = new TypeSafeJudgmentProvider({ systemOne }, { now: () => 0 });

    const first = await provider.judgeIntents(request).catch((e: unknown) => e);
    expect((first as IntentJudgmentRejectedError).affectsAllRequests).toBe(true);
    const second = await provider.judgeIntents(request).catch((e: unknown) => e);
    expect(second).toBeInstanceOf(IntentJudgmentRejectedError);
    expect((second as IntentJudgmentRejectedError).affectsAllRequests).toBe(true);
    expect(systemOne).toHaveBeenCalledTimes(1);
  });

  it("does not open the breaker for a transient failure", async () => {
    const systemOne = vi.fn().mockRejectedValue(new InternalServerError(503, body, headers()));
    const provider = new TypeSafeJudgmentProvider({ systemOne }, { now: () => 0 });
    await expect(provider.judgeIntents(request)).rejects.toBeInstanceOf(IntentJudgmentUnavailableError);
    await expect(provider.judgeIntents(request)).rejects.toBeInstanceOf(IntentJudgmentUnavailableError);
    expect(systemOne).toHaveBeenCalledTimes(2);
  });

  it("logs the first rejection once, message text only", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let clock = 0;
    const systemOne = vi.fn().mockRejectedValue(new AuthenticationError(401, body, headers()));
    const provider = new TypeSafeJudgmentProvider({ systemOne }, { now: () => clock });

    await provider.judgeIntents(request).catch(() => {});
    clock += REJECTION_COOLDOWN_MS;
    await provider.judgeIntents(request).catch(() => {});

    expect(systemOne).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [prefix, message] = errorSpy.mock.calls[0];
    expect(prefix).toBe(
      "[Intent gate] TypeSafe rejected the request; gated campaigns are closed until this is fixed:"
    );
    expect(typeof message).toBe("string");
    expect(message).not.toContain("ts_secret_value");
  });
});

describe("getJudgmentProvider", () => {
  it("makes one HTTP attempt with a five-second timeout", () => {
    vi.stubEnv("TYPESAFE_API_KEY", "ts_test_key");
    getJudgmentProvider();
    expect(sdkState.constructorArgs).toHaveLength(1);
    const [config] = sdkState.constructorArgs[0] as [{ timeout?: number; retry?: { maxRetries?: number } }];
    expect(config.timeout).toBe(5000);
    expect(config.retry?.maxRetries).toBe(0);
  });

  it("is null without a key", () => {
    // Blank it first so a real key exported on the machine cannot leak into
    // this test or its failure output.
    vi.stubEnv("TYPESAFE_API_KEY", "");
    expect(getJudgmentProvider()).toBeNull();
  });

  it("returns a TypeSafe provider once a key is present, and memoizes", () => {
    vi.stubEnv("TYPESAFE_API_KEY", "ts_test_key");
    const first = getJudgmentProvider();
    expect(first).toBeInstanceOf(TypeSafeJudgmentProvider);
    expect(getJudgmentProvider()).toBe(first);
  });

  it("closes the gate instead of throwing when client construction fails", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    sdkState.throwOnConstruct = true;
    vi.stubEnv("TYPESAFE_API_KEY", "ts_test_key");
    expect(() => getJudgmentProvider()).not.toThrow();
    expect(getJudgmentProvider()).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      "[Intent gate] TypeSafe client could not be created:",
      "bad client config"
    );
    errorSpy.mockRestore();
  });
});
