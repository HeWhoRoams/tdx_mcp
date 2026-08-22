import { describe, expect, it } from "vitest";
import { TtlCache, searchCacheKey } from "../src/services/cache.js";

describe("TtlCache", () => {
  it("returns values until they expire", () => {
    const cache = new TtlCache<string>(10);
    cache.set("a", "value", 1000);
    expect(cache.get("a")).toBe("value");
  });

  it("treats a non-positive TTL as caching disabled", () => {
    const cache = new TtlCache<string>(10);
    cache.set("a", "value", 0);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("expires entries once the TTL elapses", async () => {
    const cache = new TtlCache<string>(10);
    cache.set("a", "value", 5);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cache.get("a")).toBeUndefined();
  });

  it("evicts least-recently-used entries past the bound", () => {
    const cache = new TtlCache<number>(2);
    cache.set("a", 1, 1000);
    cache.set("b", 2, 1000);
    cache.get("a"); // marks "a" as most recently used
    cache.set("c", 3, 1000);
    expect(cache.size).toBe(2);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
  });

  it("reports staleness without dropping the value", async () => {
    const cache = new TtlCache<string>(10);
    cache.set("a", "value", 5);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cache.getAllowStale("a")).toEqual({ value: "value", stale: true });
  });

  it("deletes by prefix for write invalidation", () => {
    const cache = new TtlCache<number>(10);
    cache.set("/49/tickets/search?a=1", 1, 1000);
    cache.set("/49/tickets/search?a=2", 2, 1000);
    cache.set("/49/assets/search?a=1", 3, 1000);
    expect(cache.deleteByPrefix("/49/tickets")).toBe(2);
    expect(cache.get("/49/assets/search?a=1")).toBe(3);
  });
});

describe("searchCacheKey", () => {
  it("ignores MaxResults so different page sizes share one cached search", () => {
    expect(searchCacheKey("/49/tickets/search", { SearchText: "vpn", MaxResults: 26 })).toBe(
      searchCacheKey("/49/tickets/search", { SearchText: "vpn", MaxResults: 101 })
    );
  });

  it("is independent of key order", () => {
    expect(searchCacheKey("/x", { a: 1, b: 2 })).toBe(searchCacheKey("/x", { b: 2, a: 1 }));
  });

  it("distinguishes different filters", () => {
    expect(searchCacheKey("/x", { a: 1 })).not.toBe(searchCacheKey("/x", { a: 2 }));
  });
});
