import { getConfig } from "../config.js";
import { logger } from "./logger.js";

interface Entry<T> {
  value: T;
  expiresAtMs: number;
}

/**
 * Bounded TTL cache with LRU eviction. Bounded so long-lived HTTP deployments
 * cannot grow memory without limit.
 */
export class TtlCache<T> {
  private entries = new Map<string, Entry<T>>();
  private version = 0;

  constructor(private readonly maxEntries: number) {}

  /**
   * Bumped on every invalidation. A caller that captures this before starting a
   * request can tell whether its result was invalidated while it was in flight.
   */
  get generation(): number {
    return this.version;
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAtMs <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Re-insert to mark as most recently used.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  /** Returns the value even if expired, along with whether it is stale. */
  getAllowStale(key: string): { value: T; stale: boolean } | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    return { value: entry.value, stale: entry.expiresAtMs <= Date.now() };
  }

  set(key: string, value: T, ttlMs: number): void {
    if (ttlMs <= 0) return;
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, { value, expiresAtMs: Date.now() + ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  /** Removes every entry whose key starts with `prefix`. Used for write-invalidation. */
  deleteByPrefix(prefix: string): number {
    let removed = 0;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    this.version += 1;
    return removed;
  }

  clear(): void {
    this.entries.clear();
    this.version += 1;
  }

  get size(): number {
    return this.entries.size;
  }
}

let referenceCache: TtlCache<unknown> | undefined;
let searchCache: TtlCache<unknown> | undefined;
let recordCache: TtlCache<unknown> | undefined;

export function getReferenceCache(): TtlCache<unknown> {
  if (!referenceCache) referenceCache = new TtlCache(getConfig().cache.maxEntries);
  return referenceCache;
}

export function getSearchCache(): TtlCache<unknown> {
  if (!searchCache) searchCache = new TtlCache(getConfig().cache.maxEntries);
  return searchCache;
}

export function getRecordCache(): TtlCache<unknown> {
  if (!recordCache) recordCache = new TtlCache(getConfig().cache.maxEntries);
  return recordCache;
}

export function resetCaches(): void {
  referenceCache?.clear();
  searchCache?.clear();
  recordCache?.clear();
  referenceCache = undefined;
  searchCache = undefined;
  recordCache = undefined;
}

let cacheNamespace: (() => string | undefined) | undefined;

/**
 * Registers who the cache belongs to. Only SSO registers one; without it keys are used as-is
 * (a single shared service identity). A registered namespace that has no verified identity yet
 * maps to "unverified", which can never collide with a real person's entries.
 */
export function setCacheNamespace(provider: (() => string | undefined) | undefined): void {
  cacheNamespace = provider;
}

/** False while an SSO realm has no verified signed-in person: nothing may be cached for an unverified identity. */
export function cachingAllowed(): boolean {
  return !cacheNamespace || cacheNamespace() !== undefined;
}

export function scopedCacheKey(key: string): string {
  if (!cacheNamespace) return key;
  return `sso:${cacheNamespace() ?? "unverified"}:${key}`;
}

/**
 * Search results are cached per (endpoint + request body) so that paging through
 * an already-executed search does not re-run it upstream.
 */
export function searchCacheKey(endpoint: string, body: Record<string, unknown>): string {
  const { MaxResults: _ignored, ...rest } = body;
  const normalized = Object.keys(rest)
    .sort()
    .map((key) => `${key}=${JSON.stringify(rest[key])}`)
    .join("&");
  return scopedCacheKey(`${endpoint}?${normalized}`);
}

/**
 * Purges cached searches and records for a domain after a write. Reference data
 * (types, statuses, priorities) is deliberately left alone: it is unaffected by
 * record writes and is the data agents re-read most.
 */
export function invalidateDomain(appId: number | undefined, domain: string): void {
  const prefix = scopedCacheKey(appId === undefined ? `/${domain}` : `/${appId}/${domain}`);
  const removed = getSearchCache().deleteByPrefix(prefix) + getRecordCache().deleteByPrefix(prefix);
  if (removed > 0) logger.debug("cache invalidated", { prefix, removed });
}
