import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, paginate } from "../src/types.js";
import { RateLimiter } from "../src/services/rate-limiter.js";

const SIG = "abc12345";

describe("paginate", () => {
  const all = Array.from({ length: 10 }, (_, index) => index);

  it("returns the requested window", () => {
    const page = paginate(all, 3, 0);
    expect(page.items).toEqual([0, 1, 2]);
    expect(page.total).toBe(10);
    expect(page.count).toBe(3);
    expect(page.has_more).toBe(true);
    expect(page.next_offset).toBe(3);
  });

  it("emits a cursor that decodes to the next offset", () => {
    const page = paginate(all, 3, 0, { signature: SIG });
    expect(decodeCursor(page.next_cursor!)).toEqual({ offset: 3, signature: SIG });
  });

  it("omits the cursor when no signature is supplied", () => {
    const page = paginate(all, 3, 0);
    expect(page.next_offset).toBe(3);
    expect(page.next_cursor).toBeUndefined();
  });

  it("marks a lower-bound total when asked", () => {
    expect(paginate(all, 3, 0, { totalIsLowerBound: true }).total_is_lower_bound).toBe(true);
    expect(paginate(all, 3, 0).total_is_lower_bound).toBeUndefined();
  });

  it("omits paging hints on the final page", () => {
    const page = paginate(all, 5, 5, { signature: SIG });
    expect(page.has_more).toBe(false);
    expect(page.next_offset).toBeUndefined();
    expect(page.next_cursor).toBeUndefined();
  });

  it("handles an offset beyond the result set", () => {
    const page = paginate(all, 5, 50);
    expect(page.items).toEqual([]);
    expect(page.has_more).toBe(false);
  });
});

describe("cursors", () => {
  it("round-trips an offset and signature", () => {
    expect(decodeCursor(encodeCursor(42, SIG))).toEqual({ offset: 42, signature: SIG });
  });

  it("rejects malformed or hostile cursors", () => {
    expect(decodeCursor("not-base64!!")).toBeUndefined();
    expect(decodeCursor(Buffer.from(JSON.stringify({ o: -1, k: SIG })).toString("base64url"))).toBeUndefined();
    expect(decodeCursor(Buffer.from(JSON.stringify({ o: "5", k: SIG })).toString("base64url"))).toBeUndefined();
    expect(decodeCursor(Buffer.from(JSON.stringify({ o: 5 })).toString("base64url"))).toBeUndefined();
  });
});

describe("RateLimiter", () => {
  it("admits requests up to the limit without waiting", async () => {
    const limiter = new RateLimiter(3, 1000);
    const started = Date.now();
    await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire()]);
    expect(Date.now() - started).toBeLessThan(50);
  });

  it("queues requests beyond the limit until the window advances", async () => {
    const limiter = new RateLimiter(2, 120);
    await limiter.acquire();
    await limiter.acquire();
    const started = Date.now();
    await limiter.acquire();
    expect(Date.now() - started).toBeGreaterThanOrEqual(80);
  });
});
