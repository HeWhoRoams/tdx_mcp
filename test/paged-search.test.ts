import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfig } from "../src/config.js";
import { ToolInputError } from "../src/framework/defineTool.js";
import { resetCaches } from "../src/services/cache.js";
import * as client from "../src/services/client.js";
import { normalizePagedResponse, pagedSearch } from "../src/services/paged-search.js";

function setEnv(): void {
  process.env.TEAMDYNAMIX_BASE_URL = "https://example.teamdynamix.com";
  process.env.TEAMDYNAMIX_BEID = "b";
  process.env.TEAMDYNAMIX_WS_KEY = "k";
  process.env.TEAMDYNAMIX_SEARCH_CACHE_TTL_MS = "60000";
  resetConfig();
  resetCaches();
}

const TOTAL = 55;
const all = Array.from({ length: TOTAL }, (_, ID) => ({ ID }));

/** A server that pages like TeamDynamix saved searches: Page in, items plus total out. */
function server(shape: "object" | "array" = "object") {
  return vi.spyOn(client, "tdRequest").mockImplementation(async (_endpoint, options) => {
    const { PageIndex, PageSize } = (options?.data as { Page: { PageIndex: number; PageSize: number } }).Page;
    const rows = all.slice(PageIndex * PageSize, PageIndex * PageSize + PageSize);
    return (shape === "array" ? rows : { Results: rows, TotalCount: TOTAL }) as never;
  });
}

const ENDPOINT = "/49/tickets/searches/9/results";

describe("normalizePagedResponse", () => {
  it("accepts a bare array", () => {
    expect(normalizePagedResponse([{ ID: 1 }])).toEqual({ items: [{ ID: 1 }] });
  });

  it("finds items and a total on an object", () => {
    expect(normalizePagedResponse({ Results: [{ ID: 1 }], TotalCount: 9, Other: "x" })).toEqual({ items: [{ ID: 1 }], total: 9 });
  });

  it("finds a total on a nested Page", () => {
    expect(normalizePagedResponse({ Tickets: [{ ID: 1 }], Page: { PageIndex: 0, TotalRecords: 40 } })).toEqual({
      items: [{ ID: 1 }],
      total: 40,
    });
  });

  it("returns nothing for an unrecognised response", () => {
    expect(normalizePagedResponse(null)).toEqual({ items: [] });
    expect(normalizePagedResponse("text")).toEqual({ items: [] });
  });
});

describe("pagedSearch", () => {
  beforeEach(setEnv);
  afterEach(() => vi.restoreAllMocks());

  it("sends a Page and returns the server's real total", async () => {
    const request = server();
    const page = await pagedSearch<{ ID: number }>(ENDPOINT, { SearchText: "vpn" }, { limit: 10, offset: 0 });
    expect(request.mock.calls[0]![1]).toMatchObject({ method: "POST", data: { SearchText: "vpn", Page: { PageIndex: 0, PageSize: 10 } } });
    expect(page.total).toBe(TOTAL);
    expect(page.total_is_lower_bound).toBeUndefined();
    expect(page.items.map((row) => row.ID)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(page.has_more).toBe(true);
    expect(page.next_offset).toBe(10);
  });

  it("pages to the end with disjoint pages that cover every row", async () => {
    server();
    const seen: number[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = await pagedSearch<{ ID: number }>(ENDPOINT, {}, { limit: 20, offset: 0, ...(cursor ? { cursor } : {}) });
      seen.push(...page.items.map((row) => row.ID));
      if (!page.has_more) break;
      cursor = page.next_cursor;
    }
    expect(seen).toEqual(all.map((row) => row.ID));
  });

  it("serves an offset that is not a multiple of the page size from two server pages", async () => {
    const request = server();
    const page = await pagedSearch<{ ID: number }>(ENDPOINT, {}, { limit: 10, offset: 15 });
    expect(page.items.map((row) => row.ID)).toEqual([15, 16, 17, 18, 19, 20, 21, 22, 23, 24]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("serves a repeated page from cache", async () => {
    const request = server();
    await pagedSearch(ENDPOINT, {}, { limit: 10, offset: 0 });
    await pagedSearch(ENDPOINT, {}, { limit: 10, offset: 0 });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("counts with a one-row page and returns the exact total", async () => {
    const request = server();
    const page = await pagedSearch(ENDPOINT, {}, { limit: 25, offset: 0, count_only: true });
    expect(page).toMatchObject({ total: TOTAL, items: [] });
    expect(request.mock.calls[0]![1]).toMatchObject({ data: { Page: { PageIndex: 0, PageSize: 1 } } });
  });

  it("reports a lower bound only when the response has no total and the page is full", async () => {
    server("array");
    const full = await pagedSearch(ENDPOINT, {}, { limit: 10, offset: 0 });
    expect(full.total_is_lower_bound).toBe(true);
    expect(full.has_more).toBe(true);
    const last = await pagedSearch(ENDPOINT, {}, { limit: 10, offset: 50 });
    expect(last.items).toHaveLength(5);
    expect(last.has_more).toBe(false);
    expect(last.total).toBe(55);
    expect(last.total_is_lower_bound).toBeUndefined();
  });

  it("rejects a cursor from a different search or a malformed cursor", async () => {
    server();
    const first = await pagedSearch(ENDPOINT, { SearchText: "a" }, { limit: 10, offset: 0 });
    await expect(pagedSearch(ENDPOINT, { SearchText: "b" }, { limit: 10, offset: 0, cursor: first.next_cursor! })).rejects.toThrow(ToolInputError);
    await expect(pagedSearch(ENDPOINT, {}, { limit: 10, offset: 0, cursor: "garbage" })).rejects.toThrow(/Invalid cursor/);
  });
});
