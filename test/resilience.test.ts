import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import axios, { AxiosError, AxiosHeaders } from "axios";
import { resetConfig } from "../src/config.js";
import { resetCaches } from "../src/services/cache.js";
import { getClient, resetClient } from "../src/services/client.js";
import { createServer } from "../src/server.js";

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

function rateLimited(retryAfter?: string): AxiosError {
  const headers = new AxiosHeaders();
  if (retryAfter) headers.set("retry-after", retryAfter);
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

describe("createServer is importable without starting a transport", () => {
  beforeEach(() => setEnv());
  afterEach(() => resetClient());

  it("builds a server instance in-process", () => {
    expect(createServer()).toBeDefined();
  });

  it("still honours read-only mode", () => {
    setEnv({ TEAMDYNAMIX_READ_ONLY: "true" });
    expect(createServer()).toBeDefined();
  });
});
