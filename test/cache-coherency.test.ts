import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import axios from "axios";
import { resetConfig } from "../src/config.js";
import { getRecordCache, getReferenceCache, invalidateDomain, resetCaches, TtlCache } from "../src/services/cache.js";
import { getClient, resetClient } from "../src/services/client.js";

function setEnv(overrides: Record<string, string> = {}): void {
  process.env.TEAMDYNAMIX_BASE_URL = "https://example.teamdynamix.com";
  process.env.TEAMDYNAMIX_BEID = "b";
  process.env.TEAMDYNAMIX_WS_KEY = "k";
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
  resetConfig();
  resetCaches();
  resetClient();
}

/** Stubs axios so the client runs its real caching logic without a network. */
function stubTransport(responder: (url: string) => Promise<unknown>) {
  const jwt = `h.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.s`;
  const request = vi.fn(async (config: { url: string }) => ({ status: 200, data: await responder(config.url) }));
  vi.spyOn(axios, "create").mockReturnValue({
    request,
    post: vi.fn(async () => ({ status: 200, data: jwt })),
  } as unknown as ReturnType<typeof axios.create>);
  return request;
}

/** A response the test releases by hand, plus a signal for when it was dispatched. */
function deferredResponse() {
  let release: (value: unknown) => void = () => undefined;
  let markDispatched: () => void = () => undefined;
  const dispatched = new Promise<void>((resolve) => {
    markDispatched = resolve;
  });
  const responder = () =>
    new Promise((resolve) => {
      release = resolve;
      markDispatched();
    });
  return { responder, dispatched, release: (value: unknown) => release(value) };
}

describe("TtlCache generation", () => {
  it("advances on every invalidation", () => {
    const cache = new TtlCache<number>(10);
    const start = cache.generation;
    cache.set("a", 1, 1000);
    expect(cache.generation).toBe(start);
    cache.deleteByPrefix("a");
    expect(cache.generation).toBe(start + 1);
    cache.clear();
    expect(cache.generation).toBe(start + 2);
  });
});

describe("write invalidation racing an in-flight read", () => {
  beforeEach(() => setEnv({ TEAMDYNAMIX_RECORD_CACHE_TTL_MS: "30000" }));
  afterEach(() => {
    vi.restoreAllMocks();
    resetClient();
  });

  it("does not cache a read whose key was invalidated while it was in flight", async () => {
    const pending = deferredResponse();
    stubTransport(pending.responder);

    const read = getClient().request("/49/tickets/500", {
      cacheKey: "/49/tickets/500",
      cacheTtlMs: 30_000,
      cacheTier: "record",
    });

    // A write lands after the read is dispatched but before it returns.
    await pending.dispatched;
    invalidateDomain(49, "tickets");
    pending.release({ ID: 500, StatusName: "stale" });
    await read;

    expect(getRecordCache().get("/49/tickets/500")).toBeUndefined();
  });

  it("caches normally when no invalidation occurs", async () => {
    stubTransport(async () => ({ ID: 500, StatusName: "fresh" }));
    await getClient().request("/49/tickets/500", {
      cacheKey: "/49/tickets/500",
      cacheTtlMs: 30_000,
      cacheTier: "record",
    });
    expect(getRecordCache().get("/49/tickets/500")).toEqual({ ID: 500, StatusName: "fresh" });
  });

  it("does not let a stale-while-revalidate refresh resurrect invalidated data", async () => {
    const pending = deferredResponse();
    stubTransport(pending.responder);

    // Seed an already-expired reference entry so the next read serves stale and refreshes.
    getReferenceCache().set("/applications", [{ AppID: 1, Name: "old" }], 1);
    await new Promise((resolve) => setTimeout(resolve, 5));

    const served = await getClient().request("/applications", {
      cacheKey: "/applications",
      cacheTtlMs: 600_000,
    });
    expect(served).toEqual([{ AppID: 1, Name: "old" }]);

    await pending.dispatched;
    getReferenceCache().clear();
    pending.release([{ AppID: 1, Name: "from-before-the-write" }]);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(getReferenceCache().get("/applications")).toBeUndefined();
  });
});
