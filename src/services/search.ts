import { createHash } from "node:crypto";
import { getConfig } from "../config.js";
import { MAX_SEARCH_FETCH, PAGING_WINDOW } from "../constants.js";
import { ToolInputError } from "../framework/defineTool.js";
import { decodeCursor, paginate, type PaginatedResult } from "../types.js";
import { cachingAllowed, getSearchCache, searchCacheKey } from "./cache.js";
import { tdRequest } from "./client.js";
import { increment, logger } from "./logger.js";

interface CachedSearch<T> {
  items: T[];
  fetched: number;
}

export type SortOrder = "asc" | "desc";

export interface SearchArgs {
  limit: number;
  offset: number;
  cursor?: string;
  count_only?: boolean;
  sort_by?: string;
  sort_order?: SortOrder;
}

export interface SearchOptions {
  /** Maps a `sort_by` value to the record field it orders by. */
  sortFields?: Record<string, string>;
}

function signature(cacheKey: string, sortKey: string): string {
  return createHash("sha256").update(`${cacheKey}|${sortKey}`).digest("hex").slice(0, 8);
}

function sortKeyOf(args: SearchArgs): string {
  return args.sort_by ? `${args.sort_by}:${args.sort_order ?? "desc"}` : "";
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === undefined || a === null) return 1; // missing values sort last
  if (b === undefined || b === null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

function applySort<T>(items: T[], args: SearchArgs, options: SearchOptions): T[] {
  if (!args.sort_by) return items;
  const field = options.sortFields?.[args.sort_by];
  if (!field) {
    const allowed = Object.keys(options.sortFields ?? {}).join(", ") || "none";
    throw new ToolInputError(`Cannot sort by '${args.sort_by}'. Supported values: ${allowed}.`);
  }
  const direction = args.sort_order === "asc" ? 1 : -1;
  return [...items].sort(
    (left, right) =>
      direction * compare((left as Record<string, unknown>)[field], (right as Record<string, unknown>)[field])
  );
}

/**
 * Runs a TeamDynamix search and returns one page. Results are cached briefly so
 * paging and re-sorting an already-executed search do not re-run it upstream.
 */
export async function searchPage<T>(
  endpoint: string,
  body: Record<string, unknown>,
  args: SearchArgs,
  options: SearchOptions = {}
): Promise<PaginatedResult<T>> {
  const cacheKey = searchCacheKey(endpoint, body);
  const mayCache = cachingAllowed();
  const sig = signature(cacheKey, sortKeyOf(args));

  let offset = args.offset;
  if (args.cursor) {
    const decoded = decodeCursor(args.cursor);
    if (!decoded) throw new ToolInputError("Invalid cursor. Omit 'cursor' to start from the beginning.");
    if (decoded.signature !== sig) {
      throw new ToolInputError(
        "This cursor belongs to a different search or sort order. Omit 'cursor' to start a new search."
      );
    }
    offset = decoded.offset;
  }

  const limit = args.count_only ? 0 : args.limit;
  const needed = args.count_only ? MAX_SEARCH_FETCH : offset + limit + 1;
  const ttlMs = getConfig().cache.searchTtlMs;
  const cache = getSearchCache();

  let items: T[];
  let fetched: number;
  const cached = cache.get(cacheKey) as CachedSearch<T> | undefined;
  // A short result set means TeamDynamix returned everything it had, so the
  // cached array is complete regardless of how many rows we asked for.
  const isComplete = cached !== undefined && cached.items.length < cached.fetched;
  // Sorting a single page would rank only the rows TeamDynamix happened to
  // return first, which reads as a global ranking but is not one.
  const wantsFullWindow = args.count_only === true || args.sort_by !== undefined;
  const required = wantsFullWindow ? MAX_SEARCH_FETCH : needed;
  if (cached && (isComplete || cached.items.length >= required)) {
    increment("cacheHits");
    logger.debug("search cache hit", { endpoint, offset });
    ({ items, fetched } = cached);
  } else {
    // Search latency is mostly fixed overhead (~440 ms) plus roughly 1 ms per
    // row, so the first page stays lean and a paging request grows the window
    // geometrically: a few extra rows now save a whole round trip per later page.
    const paging = offset > 0 || cached !== undefined;
    fetched = wantsFullWindow
      ? MAX_SEARCH_FETCH
      : Math.min(MAX_SEARCH_FETCH, paging ? Math.max(needed * 2, PAGING_WINDOW) : needed);
    items =
      (await tdRequest<T[]>(endpoint, {
        method: "POST",
        data: { ...body, MaxResults: fetched },
        dedupe: true,
      })) ?? [];
    if (mayCache) cache.set(cacheKey, { items, fetched } satisfies CachedSearch<T>, ttlMs);
  }

  // TeamDynamix returned a full window, so the true match count is at least this.
  const totalIsLowerBound = items.length >= fetched;

  if (args.count_only) {
    return {
      total: items.length,
      count: 0,
      offset: 0,
      items: [],
      has_more: false,
      ...(totalIsLowerBound ? { total_is_lower_bound: true } : {}),
    };
  }

  return paginate(applySort(items, args, options), limit, offset, { signature: sig, totalIsLowerBound });
}

/** Guidance shown when a search filled its window and more records likely exist. */
export function windowHint(page: PaginatedResult<unknown>): string | undefined {
  if (!page.total_is_lower_bound) return undefined;
  return (
    `Only the first ${MAX_SEARCH_FETCH} matches are retrievable here. ` +
    `Add filters to narrow the search, or use teamdynamix_run_saved_search / teamdynamix_get_report for complete result sets.`
  );
}

/** Trailing paging and window notes shared by every search renderer. */
export function pagingFooter(page: PaginatedResult<unknown>): string[] {
  const lines: string[] = [];
  if (page.has_more) {
    lines.push(`_More results available. Use offset=${page.next_offset} or cursor=${page.next_cursor}._`);
  }
  const hint = windowHint(page);
  if (hint) lines.push(`_${hint}_`);
  return lines;
}

/** Heading shared by every search renderer, honest about lower-bound totals. */
export function resultsHeading(title: string, page: PaginatedResult<unknown>, noun: string): string[] {
  const total = `${page.total}${page.total_is_lower_bound ? "+" : ""}`;
  return [`# ${title}`, "", `Found ${total} ${noun}(s), showing ${page.count}`, ""];
}

/** Rendering for a `count_only` search. */
export function renderCount(page: PaginatedResult<unknown>, noun: string): string {
  return page.total_is_lower_bound
    ? `Matched at least ${page.total} ${noun}(s). ${windowHint(page)}`
    : `Matched ${page.total} ${noun}(s).`;
}
