import { MAX_SEARCH_FETCH } from "../constants.js";
import { ToolInputError } from "../framework/defineTool.js";
import { decodeCursor, encodeCursor, type PaginatedResult } from "../types.js";
import { cachingAllowed, getSearchCache, searchCacheKey } from "./cache.js";
import { tdRequest } from "./client.js";
import { getConfig } from "../config.js";
import { increment } from "./logger.js";
import { signature } from "./search.js";

/**
 * Paging for TeamDynamix endpoints that page on the server (saved-search results). Unlike ordinary
 * searches, these require a `Page` object, return the real total, and can be walked to the end, so
 * no 251-row window applies.
 */

export interface PagedSearchArgs {
  limit: number;
  offset: number;
  cursor?: string;
  count_only?: boolean;
}

export interface NormalizedPage<T> {
  items: T[];
  /** The server's total match count, when the response carries one. */
  total?: number;
}

/**
 * The only place that knows the shape of a server-paged response. Accepts a bare array, or an object
 * whose items are its first array-valued property and whose total is a numeric property named like
 * "total" or "count" (on the object or on a nested `Page`). `scripts/contract-test.ts --discover`
 * prints the real shape for a live organization so this can be pinned.
 */
export function normalizePagedResponse<T>(raw: unknown): NormalizedPage<T> {
  if (Array.isArray(raw)) return { items: raw as T[] };
  if (raw === null || typeof raw !== "object") return { items: [] };
  const record = raw as Record<string, unknown>;
  const itemsKey = Object.keys(record).find((key) => Array.isArray(record[key]));
  const items = itemsKey ? (record[itemsKey] as T[]) : [];
  const totalIn = (source: Record<string, unknown>): number | undefined => {
    const key = Object.keys(source).find((name) => typeof source[name] === "number" && /total/i.test(name));
    return key ? (source[key] as number) : undefined;
  };
  const nested = record.Page && typeof record.Page === "object" ? totalIn(record.Page as Record<string, unknown>) : undefined;
  const total = totalIn(record) ?? nested;
  return { items, ...(total !== undefined ? { total } : {}) };
}

export async function pagedSearch<T>(
  endpoint: string,
  body: Record<string, unknown>,
  args: PagedSearchArgs
): Promise<PaginatedResult<T>> {
  const cacheKey = searchCacheKey(endpoint, body);
  const sig = signature(cacheKey, "paged");

  let start = args.offset;
  if (args.cursor) {
    const decoded = decodeCursor(args.cursor);
    if (!decoded) throw new ToolInputError("Invalid cursor. Omit 'cursor' to start from the beginning.");
    if (decoded.signature !== sig) {
      throw new ToolInputError("This cursor belongs to a different search. Omit 'cursor' to start a new search.");
    }
    start = decoded.offset;
  }

  const cache = getSearchCache();
  const ttlMs = getConfig().cache.searchTtlMs;
  const mayCache = cachingAllowed();

  const fetchPage = async (pageIndex: number, pageSize: number): Promise<NormalizedPage<T>> => {
    const key = `${cacheKey}#p${pageIndex}x${pageSize}`;
    const cached = cache.get(key) as NormalizedPage<T> | undefined;
    if (cached) {
      increment("cacheHits");
      return cached;
    }
    const raw = await tdRequest<unknown>(endpoint, {
      method: "POST",
      data: { ...body, Page: { PageIndex: pageIndex, PageSize: pageSize } },
      dedupe: true,
    });
    const page = normalizePagedResponse<T>(raw);
    if (mayCache) cache.set(key, page, ttlMs);
    return page;
  };

  if (args.count_only) {
    const probe = await fetchPage(0, 1);
    if (probe.total !== undefined) {
      return { total: probe.total, count: 0, offset: 0, items: [], has_more: false };
    }
    // The response carries no total: count by fetching a large page and say so when it fills.
    const wide = await fetchPage(0, MAX_SEARCH_FETCH);
    const lower = wide.items.length >= MAX_SEARCH_FETCH;
    return { total: wide.items.length, count: 0, offset: 0, items: [], has_more: false, ...(lower ? { total_is_lower_bound: true } : {}) };
  }

  const size = args.limit;
  const firstIndex = Math.floor(start / size);
  const skip = start - firstIndex * size;
  const first = await fetchPage(firstIndex, size);
  let items = first.items;
  let total = first.total;
  if (skip > 0) {
    // An offset that is not a multiple of the page size straddles two server pages.
    const second = await fetchPage(firstIndex + 1, size);
    items = first.items.slice(skip).concat(second.items.slice(0, skip));
    total = total ?? second.total;
  }

  const reachedEnd = items.length < size;
  const knownTotal = total ?? start + items.length;
  const hasMore = total !== undefined ? start + items.length < total : !reachedEnd;
  const nextOffset = start + items.length;
  return {
    total: knownTotal,
    count: items.length,
    offset: start,
    items,
    has_more: hasMore,
    ...(total === undefined && hasMore ? { total_is_lower_bound: true } : {}),
    ...(hasMore ? { next_offset: nextOffset, next_cursor: encodeCursor(nextOffset, sig) } : {}),
  };
}
