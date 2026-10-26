import { increment, logger } from "./logger.js";

/**
 * Sliding-window limiter that queues outgoing requests to stay under the
 * TeamDynamix per-IP quota. Avoiding a 429 is far cheaper than recovering from
 * one, which costs a full retry cycle.
 */
export class RateLimiter {
  private timestamps: number[] = [];
  private queue: Array<() => void> = [];
  private draining = false;

  constructor(private readonly limit: number, private readonly windowMs: number) {}

  async acquire(): Promise<void> {
    if (this.queue.length === 0 && this.hasCapacity()) {
      this.timestamps.push(Date.now());
      return;
    }
    increment("rateLimitWaits");
    await new Promise<void>((resolve) => {
      this.queue.push(resolve);
      this.drain();
    });
  }

  /** Called after a 429 to hold all traffic for the server-requested cooldown. */
  penalize(delayMs: number): void {
    const now = Date.now();
    const until = now + delayMs;
    // Backdate the window so nothing is admitted until the cooldown elapses.
    this.timestamps = new Array(this.limit).fill(until - this.windowMs);
    logger.warn("rate limit penalty applied", { delayMs });
  }

  private hasCapacity(): boolean {
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
        this.queue.shift()?.();
      }
      if (this.queue.length === 0) {
        this.draining = false;
        return;
      }
      const oldest = this.timestamps[0] ?? Date.now();
      const waitMs = Math.max(10, oldest + this.windowMs - Date.now());
      setTimeout(step, waitMs).unref?.();
    };
    step();
  }
}
