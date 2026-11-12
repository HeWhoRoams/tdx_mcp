import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfig } from "../src/config.js";
import { resetCaches } from "../src/services/cache.js";
import * as client from "../src/services/client.js";
import { resultsHeading, searchPage } from "../src/services/search.js";

function setup(window?: string) {
  process.env.TEAMDYNAMIX_BASE_URL = "https://example.teamdynamix.com";
  process.env.TEAMDYNAMIX_BEID = "b";
  process.env.TEAMDYNAMIX_WS_KEY = "k";
  process.env.TEAMDYNAMIX_SEARCH_CACHE_TTL_MS = "60000";
  if (window) process.env.TEAMDYNAMIX_COUNT_WINDOW = window;
  else delete process.env.TEAMDYNAMIX_COUNT_WINDOW;
  resetConfig();
  resetCaches();
}
const data = Array.from({ length: 2000 }, (_, ID) => ({ ID, Name: `n${ID}` }));
const base = { limit: 25, offset: 0 };

beforeEach(() => {
  vi.spyOn(client, "tdRequest").mockImplementation((async (_e: string, o: { data: { MaxResults: number } }) =>
    data.slice(0, o.data.MaxResults)) as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TEAMDYNAMIX_COUNT_WINDOW;
});

describe("count window", () => {
  it("defaults to the normal search window", async () => {
    setup();
    const page = await searchPage("/1/x", {}, { ...base, count_only: true });
    expect(page.total).toBe(251);
    expect(page.total_is_lower_bound).toBe(true);
  });
  it("widens when configured, and a later page is served from the cached window", async () => {
    setup("1000");
    const counted = await searchPage("/1/x", {}, { ...base, count_only: true });
    expect(counted.total).toBe(1000);
    await searchPage("/1/x", {}, { ...base, offset: 100 });
    expect(client.tdRequest).toHaveBeenCalledTimes(1);
  });
});

describe("sort honesty", () => {
  it("flags a sort over a full window", async () => {
    setup();
    const page = await searchPage("/1/x", {}, { ...base, sort_by: "name" }, { sortFields: { name: "Name" } });
    expect(page.sorted_within_window).toBe(true);
    expect(resultsHeading("T", page, "x").join("\n")).toContain("Sorted within the first matches only");
  });
  it("does not flag a sort over a complete result", async () => {
    setup();
    vi.mocked(client.tdRequest).mockResolvedValue(data.slice(0, 5) as never);
    const page = await searchPage("/1/y", {}, { ...base, sort_by: "name" }, { sortFields: { name: "Name" } });
    expect(page.sorted_within_window).toBeUndefined();
  });
});
