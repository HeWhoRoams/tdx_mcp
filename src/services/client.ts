import axios, { AxiosError, AxiosInstance } from "axios";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { getConfig } from "../config.js";
import { increment, logger } from "./logger.js";
import {
  RateLimitAbortError,
  RateLimiterRegistry,
  RESET_MARGIN_MS,
  parseRateLimitHeaders,
  routeTemplate,
} from "./rate-limiter.js";
import { currentRequestContext } from "./request-context.js";
import { getReferenceCache, getRecordCache, scopedCacheKey, cachingAllowed } from "./cache.js";
import { createAuthorization } from "../auth/sso-composition.js";
import type { Authorization } from "../auth/authorization.js";
import {
  TeamDynamixAuthError,
  TeamDynamixPermissionError,
  TeamDynamixPolicyError,
  TeamDynamixRateLimitWaitError,
  TeamDynamixTransientAuthError,
} from "./errors.js";

export { TeamDynamixAuthError, TeamDynamixPermissionError, TeamDynamixPolicyError, TeamDynamixRateLimitWaitError, TeamDynamixTransientAuthError };
export { decodeJwtExpiryMs } from "../auth/service-account.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Reference data is stable and never purged by writes; records are short-lived and are. */
export type CacheTier = "reference" | "record";

export interface RequestOptions {
  method?: HttpMethod;
  data?: unknown;
  params?: Record<string, unknown>;
  /** Cache the response under this key for `cacheTtlMs`. Reads only. */
  cacheKey?: string;
  cacheTtlMs?: number;
  cacheTier?: CacheTier;
  /**
   * Collapse identical concurrent calls into one upstream request. Defaults to
   * GET only: TeamDynamix sends creates and comments as POST, and coalescing
   * those would silently perform a single write for two callers.
   */
  dedupe?: boolean;
}

/** Retry-After is either delta-seconds or an HTTP date. */
export function parseRetryAfterMs(header: unknown): number | undefined {
  if (typeof header !== "string" || header.trim() === "") return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Waits `ms`, ending early with a cancellation error when the caller gives up. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new RateLimitAbortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new RateLimitAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function backoffMs(attempt: number): number {
  const base = 500 * 2 ** attempt;
  return base + Math.random() * base * 0.25; // jitter avoids synchronized retries
}

/**
 * Wrapper around the TeamDynamix Web API: connection reuse, proactive rate limiting, caching,
 * single-flight de-duplication, and retry with server-directed backoff. Credentials come from the
 * injected Authorization. All tools go through `tdRequest`.
 */
export class TeamDynamixClient {
  private readonly http: AxiosInstance;
  private readonly httpAgent: HttpAgent;
  private readonly httpsAgent: HttpsAgent;
  private readonly limiter: RateLimiterRegistry;
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(private readonly auth: Authorization) {
    const config = getConfig();
    this.httpAgent = new HttpAgent({ keepAlive: true, maxSockets: config.http.maxSockets, keepAliveMsecs: 30_000 });
    this.httpsAgent = new HttpsAgent({ keepAlive: true, maxSockets: config.http.maxSockets, keepAliveMsecs: 30_000 });
    this.limiter = new RateLimiterRegistry(config.http.rateLimit, config.http.rateWindowMs, config.http.globalRateLimit);
    this.http = axios.create({
      baseURL: config.apiBaseUrl,
      timeout: config.http.timeoutMs,
      httpAgent: this.httpAgent,
      httpsAgent: this.httpsAgent,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
    });
  }

  /**
   * Fetches the JWT, the application list, and the default application's ticket
   * reference data ahead of the first tool call, so the user never waits on
   * login or ID discovery.
   */
  async warmUp(): Promise<void> {
    try {
      await this.auth.authorize();
    } catch (error) {
      logger.warn("token warm-up failed; will retry on first request", { error: String(error) });
      return;
    }

    const config = getConfig();
    const ttlMs = config.cache.referenceTtlMs;
    const paths = ["/applications"];
    if (config.defaultAppId !== undefined) {
      paths.push(
        `/${config.defaultAppId}/tickets/types`,
        `/${config.defaultAppId}/tickets/statuses`,
        `/${config.defaultAppId}/tickets/priorities`
      );
    }

    const results = await Promise.allSettled(
      paths.map((path) => this.request(path, { cacheKey: path, cacheTtlMs: ttlMs }))
    );
    const failed = results.filter((result) => result.status === "rejected").length;
    logger.debug("warm-up complete", { prefetched: paths.length - failed, failed });
  }

  async request<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
    const { method = "GET", data, params, cacheKey, cacheTtlMs = 0, cacheTier = "reference", dedupe } = options;
    const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
    const scopedKey = cacheKey ? scopedCacheKey(cacheKey) : undefined;
    const caching = Boolean(scopedKey) && cacheTtlMs > 0 && cachingAllowed();
    const cache = cacheTier === "record" ? getRecordCache() : getReferenceCache();

    // Backstop for a mis-annotated tool. POST is ambiguous (TD searches are POSTs)
    // but these verbs only ever change an existing record.
    if (!getConfig().toolPolicy.mayModify && (method === "PATCH" || method === "PUT" || method === "DELETE")) {
      throw new TeamDynamixPolicyError(
        `This server's tool policy permits no record changes, so ${method} ${path} was blocked.`
      );
    }

    // Coalesce identical concurrent reads into a single upstream call. Writes
    // must never be coalesced, so callers opt in explicitly.
    const dedupKey =
      (dedupe ?? method === "GET")
        ? `${method} ${path} ${JSON.stringify(data ?? params ?? null)}`
        : undefined;

    if (caching) {
      const entry = cache.getAllowStale(scopedKey!);
      if (entry && !entry.stale) {
        increment("cacheHits");
        logger.debug("cache hit", { endpoint: path, tier: cacheTier });
        return entry.value as T;
      }
      // Reference data changes rarely: serve the stale copy immediately and
      // refresh behind the request so no conversation waits on it.
      if (entry && cacheTier === "reference") {
        increment("staleServed");
        logger.debug("stale cache hit, refreshing", { endpoint: path });
        if (dedupKey && this.inFlight.has(dedupKey)) return entry.value as T;
        const generation = cache.generation;
        const refresh = this.execute<T>(path, method, data, params).then((fresh) => {
          if (cache.generation === generation) cache.set(scopedKey!, fresh, cacheTtlMs);
          return fresh;
        });
        if (dedupKey) {
          this.inFlight.set(dedupKey, refresh);
          void refresh.catch(() => undefined).finally(() => this.inFlight.delete(dedupKey));
        }
        refresh.catch((error) => logger.debug("background refresh failed", { endpoint: path, error: String(error) }));
        return entry.value as T;
      }
      increment("cacheMisses");
    }

    if (dedupKey) {
      const existing = this.inFlight.get(dedupKey);
      if (existing) {
        increment("dedupedRequests");
        logger.debug("request coalesced", { endpoint: path });
        return existing as Promise<T>;
      }
    }

    // A write may invalidate this key while the read is in flight; caching the
    // result afterwards would resurrect pre-write data for a full TTL.
    const generation = cache.generation;
    const promise = this.execute<T>(path, method, data, params).then((result) => {
      if (caching && cache.generation === generation) cache.set(scopedKey!, result, cacheTtlMs);
      return result;
    });

    if (dedupKey) {
      this.inFlight.set(dedupKey, promise);
      void promise.catch(() => undefined).finally(() => this.inFlight.delete(dedupKey));
    }
    return promise;
  }

  private async execute<T>(
    path: string,
    method: HttpMethod,
    data: unknown,
    params: Record<string, unknown> | undefined
  ): Promise<T> {
    const { maxRetries, maxRateLimitWaits, maxRetryDelayMs, maxQueueWaitMs } = getConfig().http;
    const started = Date.now();
    const route = routeTemplate(method, path);
    const { signal, progress } = currentRequestContext();
    // A write that has been sent cannot be recalled: aborting it would leave the outcome unknown.
    // So the signal ends a wait for a slot, and cancels a read in flight, but never a sent write.
    const abortInFlight = method === "GET" ? signal : undefined;
    let reauthorizations = 0;
    let retries = 0;
    let rateLimitWaits = 0;
    let attempt = 0;

    for (;;) {
      const expectedWaitMs = this.limiter.estimateWaitMs(route);
      if (expectedWaitMs > maxQueueWaitMs) {
        throw new TeamDynamixRateLimitWaitError(
          `TeamDynamix rate limit: about ${Math.ceil(expectedWaitMs / 1000)} s until the next slot for this operation. Nothing was sent; retry then.`
        );
      }
      if (expectedWaitMs > 2_000) progress?.(`Waiting for the TeamDynamix rate limit (about ${Math.ceil(expectedWaitMs / 1000)} s)`);
      await this.limiter.acquire(route, signal);
      const authorization = await this.auth.authorize();
      increment("requests");
      try {
        const response = await this.http.request<T>({
          url: path,
          method,
          data,
          params,
          headers: { Authorization: authorization.header },
          ...(abortInFlight ? { signal: abortInFlight } : {}),
        });
        this.limiter.observe(route, parseRateLimitHeaders(response.headers));
        logger.debug("teamdynamix request", {
          method,
          endpoint: path,
          status: response.status,
          durationMs: Date.now() - started,
          attempt,
        });
        return response.data;
      } catch (error) {
        if (!(error instanceof AxiosError)) throw error;
        const status = error.response?.status;
        attempt += 1;
        const retryAfterMs = parseRetryAfterMs(error.response?.headers?.["retry-after"]);
        const limitInfo = parseRateLimitHeaders(error.response?.headers);
        if (error.response) this.limiter.observe(route, limitInfo);
        if (signal?.aborted && error.code === "ERR_CANCELED") throw new RateLimitAbortError();

        if (status === 401) {
          const verdict = await this.auth.reportUnauthorized(authorization.fingerprint);
          if (verdict === "permission-denied") {
            throw new TeamDynamixPermissionError(
              `TeamDynamix denied ${method} ${path}. You are signed in as yourself, so your own TeamDynamix role or application access does not allow this.`
            );
          }
          if (verdict === "unknown") {
            throw new TeamDynamixTransientAuthError(
              "TeamDynamix could not confirm your sign-in just now (it did not answer cleanly). Your saved sign-in was kept; retry shortly."
            );
          }
          // "expired" or "revoked": the adapter has already discarded or updated its state, so the
          // next authorization renews, or reports that a new sign-in is required.
          reauthorizations += 1;
          if (reauthorizations > this.auth.maxReauthorizations) {
            logger.error("teamdynamix request failed", { method, endpoint: path, status, durationMs: Date.now() - started });
            throw this.auth.exhausted(error);
          }
          increment("retries");
          continue;
        }

        // A 429 tells us exactly how long to wait, so it gets its own budget and
        // may legitimately outlast the quota window. The quota is enforced per
        // IP, so another process can consume it even when this one is behaving.
        if (status === 429 && rateLimitWaits < maxRateLimitWaits) {
          rateLimitWaits += 1;
          // The reset time is the most precise answer; the margin keeps a clock difference from
          // sending the retry back into the same window.
          const untilReset = limitInfo.resetAtMs !== undefined ? Math.max(0, limitInfo.resetAtMs - Date.now()) + RESET_MARGIN_MS : undefined;
          const delayMs = Math.min(untilReset ?? retryAfterMs ?? backoffMs(rateLimitWaits), maxRetryDelayMs);
          this.limiter.penalize(route, delayMs);
          progress?.(`TeamDynamix rate limit reached; retrying in about ${Math.ceil(delayMs / 1000)} s`);
          increment("retries");
          logger.warn("rate limited by TeamDynamix; waiting before retry", {
            endpoint: path,
            delayMs,
            wait: rateLimitWaits,
            hint: "the quota is per IP, so other processes or integrations may be sharing it",
          });
          await sleep(delayMs, signal);
          continue;
        }

        if (status === 503 && retries < maxRetries) {
          retries += 1;
          const delayMs = Math.min(retryAfterMs ?? backoffMs(retries), maxRetryDelayMs);
          increment("retries");
          logger.warn("retrying teamdynamix request", { endpoint: path, status, delayMs, attempt });
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        logger.error("teamdynamix request failed", {
          method,
          endpoint: path,
          status,
          durationMs: Date.now() - started,
        });
        throw error;
      }
    }
  }

  /** Per-route rate-limit state for health checks. Route templates only. */
  rateLimits(): ReturnType<RateLimiterRegistry["snapshot"]> {
    return this.limiter.snapshot();
  }

  /** Releases sockets so short-lived processes exit promptly. */
  destroy(): void {
    this.auth.stop();
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
  }
}

let clientInstance: TeamDynamixClient | undefined;

export function getClient(): TeamDynamixClient {
  if (!clientInstance) clientInstance = new TeamDynamixClient(createAuthorization(getConfig()));
  return clientInstance;
}

export function resetClient(): void {
  clientInstance?.destroy();
  clientInstance = undefined;
}

export async function tdRequest<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
  return getClient().request<T>(endpoint, options);
}

/**
 * Convert an error thrown by tdRequest into an actionable, agent-facing message.
 */
export function handleApiError(error: unknown): string {
  if (error instanceof TeamDynamixAuthError) {
    return `Error: ${error.message}`;
  }
  if (error instanceof TeamDynamixPolicyError ||
    error instanceof TeamDynamixPermissionError ||
    error instanceof TeamDynamixTransientAuthError ||
    error instanceof TeamDynamixRateLimitWaitError ||
    error instanceof RateLimitAbortError
  ) {
    return `Error: ${error.message}`;
  }
  if (error instanceof AxiosError) {
    const status = error.response?.status;
    const body = error.response?.data;
    const bodyText = typeof body === "string" ? body : body ? JSON.stringify(body) : undefined;
    switch (status) {
      case 400:
        return `Error: TeamDynamix rejected the request as invalid (400).${
          bodyText ? ` Details: ${bodyText}` : ""
        } Check that all IDs and required fields are correct.`;
      case 401:
        return "Error: Not authenticated. Check TEAMDYNAMIX_USERNAME/PASSWORD or TEAMDYNAMIX_BEID/WS_KEY (or run `npm run login` for SSO), and confirm the account has API access.";
      case 403:
        return "Error: Permission denied. The authenticated account lacks the TeamDynamix application/permission needed for this action.";
      case 404:
        return "Error: Resource not found. Double-check the ID (and app_id, if this endpoint requires one) is correct.";
      case 429:
        return "Error: Rate limit exceeded for this TeamDynamix endpoint. Wait a bit before retrying.";
      default:
        if (error.code === "ECONNABORTED") {
          return "Error: Request to TeamDynamix timed out. Narrow the query with filters or a smaller limit, then retry.";
        }
        return `Error: TeamDynamix API request failed with status ${status ?? "unknown"}.${
          bodyText ? ` Details: ${bodyText}` : ""
        }`;
    }
  }
  return `Error: Unexpected error occurred: ${error instanceof Error ? error.message : String(error)}`;
}
