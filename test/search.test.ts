import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfig } from "../src/config.js";
import { resetCaches } from "../src/services/cache.js";
import { searchPage } from "../src/services/search.js";
import * as client from "../src/services/client.js";

function setEnv(overrides: Record<string, string> = {}): void {
  process.env.TEAMDYNAMIX_BASE_URL = "https://example.teamdynamix.com";
  process.env.TEAMDYNAMIX_BEID = "b";
  process.env.TEAMDYNAMIX_WS_KEY = "k";
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
  resetConfig();
  resetCaches();
}

const rows = (count: number) => Array.from({ length: count }, (_, index) => ({ ID: index }));

describe("searchPage", () => {
  beforeEach(() => setEnv({ TEAMDYNAMIX_SEARCH_CACHE_TTL_MS: "60000" }));
  afterEach(() => vi.restoreAllMocks());

  it("caps MaxResults at the search window", async () => {
    const request = vi.spyOn(client, "tdRequest").mockResolvedValue(rows(5));
    await searchPage("/49/tickets/search", { SearchText: "vpn" }, { limit: 25, offset: 900 });
    expect(request.mock.calls[0][1]?.data).toMatchObject({ MaxResults: 251 });
  });

  it("requests only what the page needs", async () => {
    const request = vi.spyOn(client, "tdRequest").mockResolvedValue(rows(5));
    await searchPage("/49/tickets/search", { SearchText: "vpn" }, { limit: 10, offset: 0 });
    expect(request.mock.calls[0][1]?.data).toMatchObject({ MaxResults: 11 });
  });

  it("serves a second page from cache without re-running the search", async () => {
    const request = vi.spyOn(client, "tdRequest").mockResolvedValue(rows(5));
    const first = await searchPage("/49/tickets/search", { SearchText: "vpn" }, { limit: 2, offset: 0 });
    const second = await searchPage("/49/tickets/search", { SearchText: "vpn" }, { limit: 2, offset: 2 });
    expect(request).toHaveBeenCalledTimes(1);
    expect(first.items).toHaveLength(2);
    expect(second.items).toEqual([{ ID: 2 }, { ID: 3 }]);
  });

  it("re-queries when the cached window is too small", async () => {
    // Mirror the API's own behavior: return exactly as many rows as requested.
    const request = vi
      .spyOn(client, "tdRequest")
      .mockImplementation(async (_endpoint, options) =>
        rows((options?.data as { MaxResults: number }).MaxResults) as never
      );
    await searchPage("/49/tickets/search", {}, { limit: 2, offset: 0 });
    await searchPage("/49/tickets/search", {}, { limit: 2, offset: 100 });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not share cache entries across different filters", async () => {
    const request = vi.spyOn(client, "tdRequest").mockResolvedValue(rows(5));
    await searchPage("/49/tickets/search", { SearchText: "a" }, { limit: 2, offset: 0 });
    await searchPage("/49/tickets/search", { SearchText: "b" }, { limit: 2, offset: 0 });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("skips caching entirely when the TTL is zero", async () => {
    setEnv({ TEAMDYNAMIX_SEARCH_CACHE_TTL_MS: "0" });
    const request = vi.spyOn(client, "tdRequest").mockResolvedValue(rows(5));
    await searchPage("/49/tickets/search", {}, { limit: 2, offset: 0 });
    await searchPage("/49/tickets/search", {}, { limit: 2, offset: 0 });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("tolerates an empty response body", async () => {
    vi.spyOn(client, "tdRequest").mockResolvedValue(undefined as never);
    const page = await searchPage("/49/tickets/search", {}, { limit: 5, offset: 0 });
    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
  });
});

describe("lower-bound totals", () => {
  beforeEach(() => setEnv());
  afterEach(() => vi.restoreAllMocks());

  it("flags a saturated window so 'total' is never mistaken for a true count", async () => {
    vi.spyOn(client, "tdRequest").mockImplementation(async (_endpoint, options) =>
      rows((options?.data as { MaxResults: number }).MaxResults) as never
    );
    const page = await searchPage("/49/tickets/search", {}, { limit: 25, offset: 0 });
    expect(page.total_is_lower_bound).toBe(true);
  });

  it("reports an exact total when TeamDynamix returns a short result set", async () => {
    vi.spyOn(client, "tdRequest").mockResolvedValue(rows(3));
    const page = await searchPage("/49/tickets/search", {}, { limit: 25, offset: 0 });
    expect(page.total).toBe(3);
    expect(page.total_is_lower_bound).toBeUndefined();
  });
});

describe("window growth on paging", () => {
  beforeEach(() => setEnv({ TEAMDYNAMIX_SEARCH_CACHE_TTL_MS: "60000" }));
  afterEach(() => vi.restoreAllMocks());

  const sized = () =>
    vi
      .spyOn(client, "tdRequest")
      .mockImplementation(async (_endpoint, options) =>
        rows((options?.data as { MaxResults: number }).MaxResults) as never
      );

  it("keeps the first page lean", async () => {
    const request = sized();
    await searchPage("/49/tickets/search", {}, { limit: 25, offset: 0 });
    expect(request.mock.calls[0][1]?.data).toMatchObject({ MaxResults: 26 });
  });

  it("grabs a wider window once an agent pages, so later pages are free", async () => {
    const request = sized();
    await searchPage("/49/tickets/search", {}, { limit: 25, offset: 0 });
    await searchPage("/49/tickets/search", {}, { limit: 25, offset: 25 });
    expect(request.mock.calls[1][1]?.data).toMatchObject({ MaxResults: 102 });

    await searchPage("/49/tickets/search", {}, { limit: 25, offset: 50 });
    await searchPage("/49/tickets/search", {}, { limit: 25, offset: 75 });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("grows again rather than overshooting on the first page turn", async () => {
    const request = sized();
    await searchPage("/49/tickets/search", {}, { limit: 25, offset: 0 });
    await searchPage("/49/tickets/search", {}, { limit: 25, offset: 25 });
    await searchPage("/49/tickets/search", {}, { limit: 25, offset: 125 });
    expect(request.mock.calls[2][1]?.data).toMatchObject({ MaxResults: 251 });
  });

  it("treats a direct deep-offset request as paging", async () => {
    const request = sized();
    await searchPage("/49/tickets/search", {}, { limit: 25, offset: 100 });
    expect(request.mock.calls[0][1]?.data).toMatchObject({ MaxResults: 251 });
  });

  it("pulls the full window when sorting, so the ranking is not just page one", async () => {
    const request = sized();
    await searchPage(
      "/49/tickets/search",
      {},
      { limit: 25, offset: 0, sort_by: "priority" },
      { sortFields: { priority: "PriorityID" } }
    );
    expect(request.mock.calls[0][1]?.data).toMatchObject({ MaxResults: 251 });
  });

  it("does not reuse a narrow cached window to answer a sorted request", async () => {
    const request = sized();
    await searchPage("/49/tickets/search", {}, { limit: 25, offset: 0 });
    await searchPage(
      "/49/tickets/search",
      {},
      { limit: 25, offset: 0, sort_by: "priority" },
      { sortFields: { priority: "PriorityID" } }
    );
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][1]?.data).toMatchObject({ MaxResults: 251 });
  });
});

describe("count_only", () => {
  beforeEach(() => setEnv({ TEAMDYNAMIX_SEARCH_CACHE_TTL_MS: "60000" }));
  afterEach(() => vi.restoreAllMocks());

  it("returns a count with no result bodies", async () => {
    vi.spyOn(client, "tdRequest").mockResolvedValue(rows(137));
    const page = await searchPage("/49/tickets/search", {}, { limit: 25, offset: 0, count_only: true });
    expect(page.total).toBe(137);
    expect(page.items).toEqual([]);
    expect(page.count).toBe(0);
  });

  it("warms the full window, so asking 'how many' then 'show me' costs one call", async () => {
    const request = vi
      .spyOn(client, "tdRequest")
      .mockImplementation(async (_endpoint, options) =>
        rows((options?.data as { MaxResults: number }).MaxResults) as never
      );
    await searchPage("/49/tickets/search", { IsOpen: true }, { limit: 25, offset: 0, count_only: true });
    const page = await searchPage<{ ID: number }>("/49/tickets/search", { IsOpen: true }, { limit: 10, offset: 0 });
    expect(request).toHaveBeenCalledTimes(1);
    expect(page.items).toHaveLength(10);
  });
});

describe("window sorting", () => {
  beforeEach(() => setEnv());
  afterEach(() => vi.restoreAllMocks());

  const unsorted = [{ ID: 2, PriorityID: 5 }, { ID: 1, PriorityID: 9 }, { ID: 3, PriorityID: 1 }];

  it("sorts descending by default", async () => {
    vi.spyOn(client, "tdRequest").mockResolvedValue(unsorted);
    const page = await searchPage<{ ID: number }>(
      "/49/tickets/search",
      {},
      { limit: 25, offset: 0, sort_by: "priority" },
      { sortFields: { priority: "PriorityID" } }
    );
    expect(page.items.map((item) => item.ID)).toEqual([1, 2, 3]);
  });

  it("honors ascending order", async () => {
    vi.spyOn(client, "tdRequest").mockResolvedValue(unsorted);
    const page = await searchPage<{ ID: number }>(
      "/49/tickets/search",
      {},
      { limit: 25, offset: 0, sort_by: "priority", sort_order: "asc" },
      { sortFields: { priority: "PriorityID" } }
    );
    expect(page.items.map((item) => item.ID)).toEqual([3, 2, 1]);
  });

  it("rejects an unsupported sort field with the allowed values", async () => {
    vi.spyOn(client, "tdRequest").mockResolvedValue(unsorted);
    await expect(
      searchPage("/49/tickets/search", {}, { limit: 25, offset: 0, sort_by: "nope" }, { sortFields: { priority: "PriorityID" } })
    ).rejects.toThrow(/Supported values: priority/);
  });

  it("reuses the cached window across sort orders", async () => {
    const request = vi.spyOn(client, "tdRequest").mockResolvedValue(unsorted);
    const options = { sortFields: { priority: "PriorityID" } };
    await searchPage("/49/tickets/search", {}, { limit: 25, offset: 0, sort_by: "priority" }, options);
    await searchPage("/49/tickets/search", {}, { limit: 25, offset: 0, sort_by: "priority", sort_order: "asc" }, options);
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("signed cursors", () => {
  beforeEach(() => setEnv());
  afterEach(() => vi.restoreAllMocks());

  it("pages with a cursor issued by the same search", async () => {
    vi.spyOn(client, "tdRequest").mockResolvedValue(rows(10));
    const first = await searchPage<{ ID: number }>("/49/tickets/search", { SearchText: "a" }, { limit: 2, offset: 0 });
    const second = await searchPage<{ ID: number }>(
      "/49/tickets/search",
      { SearchText: "a" },
      { limit: 2, offset: 0, cursor: first.next_cursor }
    );
    expect(second.items.map((item) => item.ID)).toEqual([2, 3]);
  });

  it("refuses a cursor replayed against a different search", async () => {
    vi.spyOn(client, "tdRequest").mockResolvedValue(rows(10));
    const first = await searchPage("/49/tickets/search", { SearchText: "a" }, { limit: 2, offset: 0 });
    await expect(
      searchPage("/49/tickets/search", { SearchText: "b" }, { limit: 2, offset: 0, cursor: first.next_cursor })
    ).rejects.toThrow(/different search or sort order/);
  });

  it("refuses a cursor when the sort order changes", async () => {
    vi.spyOn(client, "tdRequest").mockResolvedValue(rows(10));
    const options = { sortFields: { id: "ID" } };
    const first = await searchPage("/49/tickets/search", {}, { limit: 2, offset: 0, sort_by: "id" }, options);
    await expect(
      searchPage("/49/tickets/search", {}, { limit: 2, offset: 0, sort_by: "id", sort_order: "asc", cursor: first.next_cursor }, options)
    ).rejects.toThrow(/different search or sort order/);
  });

  it("rejects a malformed cursor", async () => {
    vi.spyOn(client, "tdRequest").mockResolvedValue(rows(10));
    await expect(
      searchPage("/49/tickets/search", {}, { limit: 5, offset: 0, cursor: "bogus!!" })
    ).rejects.toThrow(/Invalid cursor/);
  });
});
