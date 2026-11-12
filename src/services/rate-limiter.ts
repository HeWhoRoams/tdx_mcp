import { increment, logger } from "./logger.js";

/** TeamDynamix asks callers to keep at least this much margin past a stated reset. */
export const RESET_MARGIN_MS = 5_000;

export class RateLimitAbortError extends Error {
  constructor() {
    super("The request was cancelled while waiting for a TeamDynamix rate limit slot.");
  }
}

interface Waiter {
  resolve: () => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

/**
 * Sliding-window limiter that queues outgoing requests to stay under a TeamDynamix quota. Avoiding a
 * 429 is far cheaper than recovering from one, which costs a full retry cycle. A limit learned from
 * response headers replaces the configured one, and a bucket that reports no remaining calls holds
 * until its reset.
 */
export class RateLimiter {
  private timestamps: number[] = [];
  private queue: Waiter[] = [];
  private draining = false;
  private holdUntil = 0;

  constructor(
    private limit: number,
    private readonly windowMs: number
  ) {}

  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new RateLimitAbortError();
    if (this.queue.length === 0 && this.hasCapacity()) {
      this.timestamps.push(Date.now());
      return;
    }
    increment("rateLimitWaits");
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener("abort", onAbort),
      };
      const onAbort = () => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        waiter.cleanup();
        reject(new RateLimitAbortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(waiter);
      this.drain();
    });
  }

  /** Called after a 429 to hold all traffic for the server-requested cooldown. */
  penalize(delayMs: number): void {
    this.holdUntil = Math.max(this.holdUntil, Date.now() + delayMs);
    logger.warn("rate limit penalty applied", { delayMs });
  }

  /** Learns from `X-RateLimit-*` headers. */
  observe(info: { limit?: number; remaining?: number; resetAtMs?: number }): void {
    if (info.limit !== undefined && info.limit > 0) this.limit = info.limit;
    if (info.remaining !== undefined && info.remaining <= 0 && info.resetAtMs !== undefined) {
      this.holdUntil = Math.max(this.holdUntil, info.resetAtMs + RESET_MARGIN_MS);
    }
  }

  /** Roughly how long a request made now would wait for a slot. */
  estimateWaitMs(): number {
    const now = Date.now();
    const hold = Math.max(0, this.holdUntil - now);
    if (this.queue.length === 0 && this.hasCapacity() && hold === 0) return 0;
    const cutoff = now - this.windowMs;
    const live = this.timestamps.filter((entry) => entry > cutoff);
    const windowWait = live.length >= this.limit ? Math.max(0, (live[0] ?? now) + this.windowMs - now) : 0;
    const perSlot = this.windowMs / this.limit;
    return Math.max(hold, windowWait) + this.queue.length * perSlot;
  }

  snapshot(): { limit: number; used: number; remaining: number; holdUntil?: string } {
    const cutoff = Date.now() - this.windowMs;
    const used = this.timestamps.filter((entry) => entry > cutoff).length;
    return {
      limit: this.limit,
      used,
      remaining: Math.max(0, this.limit - used),
      ...(this.holdUntil > Date.now() ? { holdUntil: new Date(this.holdUntil).toISOString() } : {}),
    };
  }

  private hasCapacity(): boolean {
    if (Date.now() < this.holdUntil) return false;
    const cutoff = Date.now() - this.windowMs;
    this.timestamps = this.timestamps.filter((entry) => entry > cutoff);
    return this.timestamps.length < this.limit;
  }

  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    const step = () => {
      while (this.queue.length > 0 && this.hasCapacity()) {
        this.timestamps.push(Date.now());
        const waiter = this.queue.shift()!;
        waiter.cleanup();
        waiter.resolve();
      }
      if (this.queue.length === 0) {
        this.draining = false;
        return;
      }
      const oldest = this.timestamps[0] ?? Date.now();
      const waitMs = Math.max(10, this.holdUntil - Date.now(), oldest + this.windowMs - Date.now());
      // Not unref'd: a queued request must keep a short-lived script alive until it is released.
      setTimeout(step, waitMs);
    };
    step();
  }
}

/** Route template for a request: numeric and UID-like segments become `{id}`, query strings are dropped. */
export function routeTemplate(method: string, path: string): string {
  const clean = path.split("?")[0] ?? path;
  const segments = clean
    .split("/")
    .map((segment) => (/^\d+$/.test(segment) || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment) ? "{id}" : segment));
  return `${method.toUpperCase()} ${segments.join("/")}`;
}

/**
 * One limiter per route, because TeamDynamix limits individual methods rather than the whole API,
 * plus an optional ceiling across all of them for deployments that share an IP with other integrations.
 */
export class RateLimiterRegistry {
  private readonly buckets = new Map<string, RateLimiter>();
  private readonly global?: RateLimiter;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    globalLimit = 0
  ) {
    if (globalLimit > 0) this.global = new RateLimiter(globalLimit, windowMs);
  }

  private bucket(key: string): RateLimiter {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = new RateLimiter(this.limit, this.windowMs);
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  async acquire(key: string, signal?: AbortSignal): Promise<void> {
    await this.bucket(key).acquire(signal);
    await this.global?.acquire(signal);
  }

  penalize(key: string, delayMs: number): void {
    this.bucket(key).penalize(delayMs);
  }

  observe(key: string, info: { limit?: number; remaining?: number; resetAtMs?: number }): void {
    this.bucket(key).observe(info);
  }

  estimateWaitMs(key: string): number {
    return Math.max(this.bucket(key).estimateWaitMs(), this.global?.estimateWaitMs() ?? 0);
  }

  /** Route templates only, so nothing identifying leaves through a health check. */
  snapshot(): Record<string, ReturnType<RateLimiter["snapshot"]>> {
    return Object.fromEntries([...this.buckets].map(([key, bucket]) => [key, bucket.snapshot()]));
  }
}

/** Reads `X-RateLimit-*` headers. The reset is an RFC 1123 date. */
export function parseRateLimitHeaders(headers: unknown): { limit?: number; remaining?: number; resetAtMs?: number } {
  const get = (name: string): unknown => {
    if (!headers || typeof headers !== "object") return undefined;
    const bag = headers as { get?: (key: string) => unknown } & Record<string, unknown>;
    return typeof bag.get === "function" ? bag.get(name) : bag[name];
  };
  const number = (value: unknown): number | undefined => {
    const parsed = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const reset = get("x-ratelimit-reset");
  const resetAtMs = typeof reset === "string" ? Date.parse(reset) : undefined;
  return {
    ...(number(get("x-ratelimit-limit")) !== undefined ? { limit: number(get("x-ratelimit-limit"))! } : {}),
    ...(number(get("x-ratelimit-remaining")) !== undefined ? { remaining: number(get("x-ratelimit-remaining"))! } : {}),
    ...(resetAtMs !== undefined && !Number.isNaN(resetAtMs) ? { resetAtMs } : {}),
  };
}
