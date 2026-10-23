import { FALLBACK_TOKEN_LIFETIME_MS } from "../auth/sso-types.js";
import axios, { AxiosError, AxiosInstance } from "axios";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { getConfig } from "../config.js";
import { increment, logger } from "./logger.js";
import { RateLimiter } from "./rate-limiter.js";
import { createServiceTokenStore, type TokenStore } from "./token-store.js";
import { getReferenceCache, getRecordCache, scopedCacheKey } from "./cache.js";
import { createSsoAuthorization } from "../auth/sso-composition.js";
import type { SsoAuthorization } from "../auth/sso-lifecycle.js";
import { SSO_ACTION_REQUIRED, SSO_RENEWAL_UNAVAILABLE, SsoUnavailableError } from "../auth/sso-errors.js";

export class TeamDynamixAuthError extends Error {}

/** Signed in as the user, but TeamDynamix says this user may not do that. */
export class TeamDynamixPermissionError extends Error {}

/** Signed in, but TeamDynamix could not confirm the sign-in right now (timeout, 429, 5xx). Nothing was discarded. */
export class TeamDynamixTransientAuthError extends Error {}

/** A request that the tool policy forbids reached the transport anyway. */
export class TeamDynamixPolicyError extends Error {}

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

/**
 * Decode a JWT's payload without verifying its signature (we don't have the
 * signing key -- TeamDynamix does -- we only need the "exp" claim so we know
 * when to refresh).
 */
export function decodeJwtExpiryMs(token: string): number | undefined {
  try {
    const payload = token.split(".")[1];
    if (!payload) return undefined;
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
    const parsed = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as { exp?: number };
    return typeof parsed.exp === "number" ? parsed.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

function requireJwt(value: unknown): string {
  const token = typeof value === "string" ? value.trim() : String(value);
  if (token.split(".").length !== 3) {
    throw new TeamDynamixAuthError(
      "TeamDynamix authentication did not return a JWT. The API URL may be redirecting to the web login page."
    );
  }
  return token;
}

/** Retry-After is either delta-seconds or an HTTP date. */
export function parseRetryAfterMs(header: unknown): number | undefined {
  if (typeof header !== "string" || header.trim() === "") return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function backoffMs(attempt: number): number {
  const base = 500 * 2 ** attempt;
  return base + Math.random() * base * 0.25; // jitter avoids synchronized retries
}

/**
 * Wrapper around the TeamDynamix Web API: JWT auth with refresh, connection
 * reuse, proactive rate limiting, single-flight de-duplication, and retry with
 * server-directed backoff. All tools go through `tdRequest`.
 */
export class TeamDynamixClient {
  private readonly http: AxiosInstance;
  private readonly httpAgent: HttpAgent;
  private readonly httpsAgent: HttpsAgent;
  private readonly limiter: RateLimiter;
  private readonly tokens: TokenStore;
  private loginInFlight: Promise<string> | undefined;
  private readonly inFlight = new Map<string, Promise<unknown>>();

  /** `sso` is supplied by the composition root for per-user sign-in; absent for service accounts. */
  constructor(private readonly sso?: SsoAuthorization) {
    const config = getConfig();
    this.httpAgent = new HttpAgent({ keepAlive: true, maxSockets: config.http.maxSockets, keepAliveMsecs: 30_000 });
    this.httpsAgent = new HttpsAgent({ keepAlive: true, maxSockets: config.http.maxSockets, keepAliveMsecs: 30_000 });
    this.limiter = new RateLimiter(config.http.rateLimit, config.http.rateWindowMs);
    this.tokens = createServiceTokenStore();
    this.http = axios.create({
      baseURL: config.apiBaseUrl,
      timeout: config.http.timeoutMs,
      httpAgent: this.httpAgent,
      httpsAgent: this.httpsAgent,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
    });
  }

  private async login(): Promise<string> {
    const config = getConfig();
    if (config.auth.method === "sso") {
      // SSO needs a human at a browser. The server never starts one on its own.
      throw new TeamDynamixAuthError(`${SSO_ACTION_REQUIRED}: sign in with \`npm run login\`, then retry.`);
    }
    const started = Date.now();
    try {
      // The login endpoints return the raw JWT as text/plain; axios hands it back as response.data.
      const response =
        config.auth.method === "admin"
          ? await this.http.post<string>(
              "/auth/loginadmin",
              { BEID: config.auth.beid, WebServicesKey: config.auth.wsKey },
              { maxRedirects: 0 }
            )
          : await this.http.post<string>(
              "/auth/login",
              { username: config.auth.username, password: config.auth.password },
              { maxRedirects: 0 }
            );
      const token = requireJwt(response.data);
      const expiresAtMs = decodeJwtExpiryMs(token) ?? Date.now() + FALLBACK_TOKEN_LIFETIME_MS;
      this.tokens.write({ token, expiresAtMs });
      logger.info("authenticated with TeamDynamix", { method: config.auth.method, durationMs: Date.now() - started });
      return token;
    } catch (error) {
      throw new TeamDynamixAuthError(
        `Failed to authenticate with TeamDynamix using ${config.auth.method} credentials: ${
          error instanceof AxiosError ? error.response?.data ?? error.message : String(error)
        }`
      );
    }
  }

  private async getAuthorization(): Promise<{ header: string; fingerprint?: string }> {
    if (this.sso) {
      try {
        return await this.sso.authorize();
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        throw new TeamDynamixAuthError(
          `${error instanceof SsoUnavailableError ? SSO_RENEWAL_UNAVAILABLE : SSO_ACTION_REQUIRED}: ${message}`.trim()
        );
      }
    }
    return { header: `Bearer ${await this.getToken()}` };
  }

  private async getToken(): Promise<string> {
    const bufferMs = 60_000; // refresh a minute before expiry
    const cached = this.tokens.read();
    if (cached && cached.expiresAtMs - bufferMs > Date.now()) return cached.token;
    if (!this.loginInFlight) {
      this.loginInFlight = this.login().finally(() => {
        this.loginInFlight = undefined;
      });
    }
    return this.loginInFlight;
  }

  /**
   * Fetches the JWT, the application list, and the default application's ticket
   * reference data ahead of the first tool call, so the user never waits on
   * login or ID discovery.
   */
  async warmUp(): Promise<void> {
    try {
      await this.getAuthorization();
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
    const caching = Boolean(scopedKey) && cacheTtlMs > 0;
    const cache = cacheTier === "record" ? getRecordCache() : getReferenceCache();

    // Backstop for a mis-annotated tool. POST is ambiguous (TD searches are POSTs)
    // but these verbs only ever change an existing record.
    if (!getConfig().toolPolicy.mayModify && (method === "PATCH" || method === "PUT" || method === "DELETE")) {
      throw new TeamDynamixPolicyError(
        `This server's tool policy permits no record changes, so ${method} ${path} was blocked.`
      );
    }

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
        const generation = cache.generation;
        void this.execute<T>(path, method, data, params)
          .then((fresh) => {
            if (cache.generation === generation) cache.set(scopedKey!, fresh, cacheTtlMs);
          })
          .catch((error) => logger.debug("background refresh failed", { endpoint: path, error: String(error) }));
        return entry.value as T;
      }
      increment("cacheMisses");
    }

    // Coalesce identical concurrent reads into a single upstream call. Writes
    // must never be coalesced, so callers opt in explicitly.
    const dedupKey =
      (dedupe ?? method === "GET")
        ? `${method} ${path} ${JSON.stringify(data ?? params ?? null)}`
        : undefined;
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
    const { maxRetries, maxRateLimitWaits, maxRetryDelayMs } = getConfig().http;
    const started = Date.now();
    let refreshedToken = false;
    let retries = 0;
    let rateLimitWaits = 0;
    let attempt = 0;

    for (;;) {
      await this.limiter.acquire();
      const authorization = await this.getAuthorization();
      increment("requests");
      try {
        const response = await this.http.request<T>({
          url: path,
          method,
          data,
          params,
          headers: { Authorization: authorization.header },
        });
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

        if (status === 401 && this.sso && authorization.fingerprint) {
          const verdict = await this.sso.reportUnauthorized(authorization.fingerprint);
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
          // "expired" or "revoked": the lifecycle has already updated its state, so
          // getToken() now renews, or reports that a new sign-in is required.
          increment("retries");
          continue;
        }

        if (status === 401 && !refreshedToken) {
          // Token invalidated server-side: force a refresh and retry once.
          refreshedToken = true;
          this.tokens.clear();
          increment("retries");
          continue;
        }

        // A 429 tells us exactly how long to wait, so it gets its own budget and
        // may legitimately outlast the quota window. The quota is enforced per
        // IP, so another process can consume it even when this one is behaving.
        if (status === 429 && rateLimitWaits < maxRateLimitWaits) {
          rateLimitWaits += 1;
          const delayMs = Math.min(retryAfterMs ?? backoffMs(rateLimitWaits), maxRetryDelayMs);
          this.limiter.penalize(delayMs);
          increment("retries");
          logger.warn("rate limited by TeamDynamix; waiting before retry", {
            endpoint: path,
            delayMs,
            wait: rateLimitWaits,
            hint: "the quota is per IP, so other processes or integrations may be sharing it",
          });
          await new Promise((resolve) => setTimeout(resolve, delayMs));
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

  /** Releases sockets so short-lived processes exit promptly. */
  destroy(): void {
    this.sso?.stop();
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
  }
}

let clientInstance: TeamDynamixClient | undefined;

export function getClient(): TeamDynamixClient {
  if (!clientInstance) clientInstance = new TeamDynamixClient(createSsoAuthorization(getConfig()));
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
    error instanceof TeamDynamixTransientAuthError
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
