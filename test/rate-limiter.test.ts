import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseRateLimitHeaders,
  RateLimitAbortError,
  RateLimiter,
  RateLimiterRegistry,
  RESET_MARGIN_MS,
  routeTemplate,
} from "../src/services/rate-limiter.js";

afterEach(() => vi.restoreAllMocks());

describe("RateLimiter", () => {
  it("releases queued requests in order, each after the window", async () => {
    const limiter = new RateLimiter(1, 50);
    const order: number[] = [];
    const start = Date.now();
    await Promise.all(
      [1, 2, 3].map((n) =>
        limiter.acquire().then(() => {
          order.push(n);
        })
      )
    );
    expect(order).toEqual([1, 2, 3]);
    expect(Date.now() - start).toBeGreaterThanOrEqual(90);
  });

  it("keeps the process alive while requests are queued", async () => {
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      const timer = realSetTimeout(fn, ms);
      timers.push(timer);
      return timer;
    }) as typeof setTimeout);

    const limiter = new RateLimiter(1, 30);
    await limiter.acquire();
    const queued = limiter.acquire();

    expect(timers.length).toBeGreaterThan(0);
    // An unref'd timer lets a short script exit with the request still unresolved.
    expect(timers.every((timer) => timer.hasRef())).toBe(true);
    await queued;
  });
});

describe("routeTemplate", () => {
  it("replaces ids and uids and drops the query", () => {
    expect(routeTemplate("post", "/49/tickets/search")).toBe("POST /{id}/tickets/search");
    expect(routeTemplate("GET", "/49/tickets/1234/feed?x=1")).toBe("GET /{id}/tickets/{id}/feed");
    expect(routeTemplate("GET", "/people/5c1e8a52-1111-2222-3333-444455556666")).toBe("GET /people/{id}");
  });
});

describe("RateLimiterRegistry", () => {
  it("keeps routes independent", async () => {
    const registry = new RateLimiterRegistry(1, 10_000);
    await registry.acquire("GET /a");
    expect(registry.estimateWaitMs("GET /a")).toBeGreaterThan(0);
    expect(registry.estimateWaitMs("GET /b")).toBe(0);
    await registry.acquire("GET /b");
  });

  it("holds a route until its stated reset plus the margin when nothing remains", () => {
    const registry = new RateLimiterRegistry(30, 60_000);
    registry.observe("GET /a", { limit: 30, remaining: 0, resetAtMs: Date.now() + 2_000 });
    const wait = registry.estimateWaitMs("GET /a");
    expect(wait).toBeGreaterThan(2_000 + RESET_MARGIN_MS - 500);
    expect(registry.estimateWaitMs("GET /b")).toBe(0);
  });

  it("replaces the configured limit with the one the server reports", () => {
    const registry = new RateLimiterRegistry(30, 60_000);
    registry.observe("GET /a", { limit: 5 });
    expect(registry.snapshot()["GET /a"]?.limit).toBe(5);
  });

  it("applies an optional ceiling across routes", async () => {
    const registry = new RateLimiterRegistry(10, 10_000, 1);
    await registry.acquire("GET /a");
    expect(registry.estimateWaitMs("GET /b")).toBeGreaterThan(0);
  });
});

describe("abort", () => {
  it("removes a queued waiter and rejects", async () => {
    const limiter = new RateLimiter(1, 10_000);
    await limiter.acquire();
    const controller = new AbortController();
    const queued = limiter.acquire(controller.signal);
    controller.abort();
    await expect(queued).rejects.toBeInstanceOf(RateLimitAbortError);
    expect(limiter.estimateWaitMs()).toBeLessThanOrEqual(10_000);
  });

  it("rejects at once when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(new RateLimiter(5, 1000).acquire(controller.signal)).rejects.toBeInstanceOf(RateLimitAbortError);
  });
});

describe("parseRateLimitHeaders", () => {
  it("reads limit, remaining and an RFC 1123 reset", () => {
    const reset = new Date(Date.now() + 5_000).toUTCString();
    const parsed = parseRateLimitHeaders({ "x-ratelimit-limit": "60", "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset });
    expect(parsed).toMatchObject({ limit: 60, remaining: 0 });
    expect(parsed.resetAtMs).toBe(Date.parse(reset));
  });
  it("tolerates missing headers", () => {
    expect(parseRateLimitHeaders(undefined)).toEqual({});
  });
});
