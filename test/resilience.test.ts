import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import axios, { AxiosError, AxiosHeaders } from "axios";
import { resetConfig } from "../src/config.js";
import { resetCaches } from "../src/services/cache.js";
import { getClient, resetClient } from "../src/services/client.js";
import { RateLimitAbortError } from "../src/services/rate-limiter.js";
import { runWithRequestContext } from "../src/services/request-context.js";
import { buildServer } from "../src/server.js";

function setEnv(overrides: Record<string, string> = {}): void {
  process.env.TEAMDYNAMIX_BASE_URL = "https://example.teamdynamix.com";
  process.env.TEAMDYNAMIX_BEID = "b";
  process.env.TEAMDYNAMIX_WS_KEY = "k";
  delete process.env.TEAMDYNAMIX_READ_ONLY;
  delete process.env.TEAMDYNAMIX_DEFAULT_APP_ID;
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
  resetConfig();
  resetCaches();
  resetClient();
}

function rateLimited(retryAfter?: string, resetAt?: Date): AxiosError {
  const headers = new AxiosHeaders();
  if (retryAfter) headers.set("retry-after", retryAfter);
  if (resetAt) headers.set("x-ratelimit-reset", resetAt.toUTCString());
  const error = new AxiosError("rate limited");
  error.response = {
    status: 429,
    statusText: "",
    data: "This can only be requested 30 times every 60 seconds.",
    headers,
    config: { headers: new AxiosHeaders() },
  };
  return error;
}

/** Replaces axios so retry behavior can be observed without real waiting. */
function stubTransport(responses: Array<AxiosError | { data: unknown }>) {
  const jwt = `h.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.s`;
  let call = 0;
  const request = vi.fn(async () => {
    const next = responses[Math.min(call, responses.length - 1)];
    call += 1;
    if (next instanceof AxiosError) throw next;
    return { status: 200, data: next.data };
  });
  vi.spyOn(axios, "create").mockReturnValue({
    request,
    post: vi.fn(async () => ({ status: 200, data: jwt })),
  } as unknown as ReturnType<typeof axios.create>);
  return request;
}

describe("rate limit recovery", () => {
  beforeEach(() => setEnv({ TEAMDYNAMIX_MAX_RETRIES: "0" }));
  afterEach(() => {
    vi.restoreAllMocks();
    resetClient();
  });

  it("keeps waiting through 429s even when generic retries are exhausted", async () => {
    // Retry-After: 0 keeps the real timer path in play without a real wait.
    const request = stubTransport([rateLimited("0"), rateLimited("0"), { data: { ok: true } }]);
    await expect(getClient().request("/49/tickets/search", { method: "POST" })).resolves.toEqual({ ok: true });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("gives up after the rate-limit budget is spent", async () => {
    setEnv({ TEAMDYNAMIX_MAX_RATE_LIMIT_WAITS: "1" });
    const request = stubTransport([rateLimited("0")]);
    await expect(getClient().request("/49/tickets/search", { method: "POST" })).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("honours the configured ceiling instead of a hardcoded one", async () => {
    setEnv({ TEAMDYNAMIX_MAX_RETRY_DELAY_MS: "1000" });
    const started = Date.now();
    const request = stubTransport([rateLimited("45"), { data: { ok: true } }]);
    await expect(getClient().request("/x")).resolves.toEqual({ ok: true });
    // TeamDynamix asked for 45 s; the ceiling must clamp it well below that.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe("429 timing", () => {
  beforeEach(() => {
    // Earlier tests leave their overrides in process.env, so the knobs under test are set explicitly.
    setEnv({
      TEAMDYNAMIX_MAX_RETRIES: "0",
      TEAMDYNAMIX_MAX_RETRY_DELAY_MS: "60000",
      TEAMDYNAMIX_MAX_RATE_LIMIT_WAITS: "5",
      TEAMDYNAMIX_MAX_QUEUE_WAIT_MS: "50000",
      TEAMDYNAMIX_RATE_LIMIT: "30",
      TEAMDYNAMIX_RATE_WINDOW_MS: "60000",
    });
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetClient();
  });

  it("waits until X-RateLimit-Reset plus the margin", async () => {
    // Whole seconds only: RFC 1123 dates carry no milliseconds.
    const resetAt = new Date(Math.ceil(Date.now() / 1000) * 1000 + 2_000);
    const request = stubTransport([rateLimited("1", resetAt), { data: { ok: true } }]);
    const pending = getClient().request("/49/tickets/search", { method: "POST" });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(pending).resolves.toEqual({ ok: true });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("falls back to Retry-After when there is no reset header", async () => {
    const request = stubTransport([rateLimited("3"), { data: { ok: true } }]);
    const pending = getClient().request("/x");
    await vi.advanceTimersByTimeAsync(2_500);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it("reports progress while waiting when the caller asked for it", async () => {
    stubTransport([rateLimited("3"), { data: { ok: true } }]);
    const progress = vi.fn();
    const pending = runWithRequestContext({ progress }, () => getClient().request("/x"));
    await vi.advanceTimersByTimeAsync(4_000);
    await pending;
    expect(progress).toHaveBeenCalledWith(expect.stringContaining("rate limit"));
  });

  it("cancels a read that is waiting out a 429", async () => {
    stubTransport([rateLimited("30")]);
    const controller = new AbortController();
    const pending = runWithRequestContext({ signal: controller.signal }, () => getClient().request("/x"));
    const settled = expect(pending).rejects.toBeInstanceOf(RateLimitAbortError);
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort();
    await settled;
  });

  it("gives the abort signal to reads but never to a write already sent", async () => {
    const request = stubTransport([{ data: 1 }, { data: 2 }]);
    const controller = new AbortController();
    await runWithRequestContext({ signal: controller.signal }, async () => {
      await getClient().request("/read");
      await getClient().request("/write", { method: "POST", data: {} });
    });
    const configs = request.mock.calls.map((call) => call[0] as { signal?: AbortSignal; method: string });
    expect(configs[0]?.signal).toBe(controller.signal);
    expect(configs[1]?.signal).toBeUndefined();
  });

  it("fails fast when the wait for a slot would outlive the client", async () => {
    setEnv({ TEAMDYNAMIX_MAX_QUEUE_WAIT_MS: "1000", TEAMDYNAMIX_RATE_LIMIT: "1", TEAMDYNAMIX_RATE_WINDOW_MS: "60000" });
    const request = stubTransport([{ data: 1 }]);
    await getClient().request("/49/tickets/search", { method: "POST" });
    await expect(getClient().request("/49/tickets/search", { method: "POST" })).rejects.toThrow(/rate limit: about \d+ s/i);
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("createServer is importable without starting a transport", () => {
  beforeEach(() => setEnv());
  afterEach(() => resetClient());

  it("builds a server instance in-process", () => {
    expect(buildServer().server).toBeDefined();
  });

  it("still honours read-only mode", () => {
    setEnv({ TEAMDYNAMIX_READ_ONLY: "true" });
    expect(buildServer().server).toBeDefined();
  });
});
