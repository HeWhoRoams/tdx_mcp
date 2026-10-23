import type { RealmLock } from "./realm-lock.js";
import type { SsoBrowserSession } from "./sso-browser.js";
import { describeBlockReason, type BlockReason, type CredentialState } from "./credential-state.js";
import {
  isRetryable,
  SsoActionRequiredError,
  SsoRenewalDiscardedError,
  SsoUnavailableError,
  type SsoFailureKind,
} from "./sso-errors.js";
import { SsoLoginError } from "./sso-login.js";
import type { StoredToken } from "../services/token-store.js";

export { SsoActionRequiredError } from "./sso-errors.js";

/** Never make a tool call wait on a browser while the token still has at least this long to live. */
export const RENEWAL_SAFETY_MS = 2 * 60_000;
const IN_CALL_BASE_MS = 2_000;
const IN_CALL_CAP_MS = 15_000;
const RETRY_BASE_MS = 30_000;
const RETRY_CAP_MS = 15 * 60_000;
const MIN_RETRY_MS = 5_000;

/** Exponential backoff with +/-20% jitter, capped. */
export function backoffDelayMs(
  attempt: number,
  baseMs: number,
  capMs: number,
  random: () => number = Math.random
): number {
  const exponential = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.min(capMs, Math.round(exponential * (0.8 + 0.4 * random())));
}

export type SsoRenewalAuditEvent =
  | "renewal_started"
  | "renewal_succeeded"
  | "renewal_failed"
  | "renewal_discarded"
  | "renewal_blocked";

export interface SsoRenewalDependencies {
  state: CredentialState;
  leadMs: number;
  retries: number;
  openSession(): Promise<SsoBrowserSession>;
  validateToken(token: string, previous?: StoredToken): Promise<StoredToken>;
  audit?(event: SsoRenewalAuditEvent, fields?: Record<string, unknown>): void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Held for a whole renewal so only one process at a time opens the shared browser profile. */
  renewalLock?: RealmLock;
  /** How long to wait for another process's renewal before giving up (not a failure that blocks). */
  peerWaitMs?: number;
}

const PEER_WAIT_MS = 45_000;
const PEER_POLL_MS = 500;

function failureKind(error: unknown): SsoFailureKind {
  return error instanceof SsoLoginError ? error.kind : "transient";
}

function blockedMessage(reason: BlockReason): string {
  return `TeamDynamix sign-in required: ${describeBlockReason(reason)}. Run \`npm run login\` before retrying.`;
}

/**
 * Owns one realm's token renewal: single-flight, classified failures, bounded
 * backoff. A still-valid token is never made unusable by a failed renewal.
 */
export class SsoRenewalManager {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private inFlight: Promise<string> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private consecutiveFailures = 0;
  private retryNotBeforeMs = 0;

  constructor(private readonly dependencies: SsoRenewalDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = dependencies.random ?? Math.random;
  }

  start(): void {
    const status = this.dependencies.state.status();
    if (status.kind === "usable") this.scheduleAt(status.token.expiresAtMs - this.dependencies.leadMs);
    else if (status.kind === "needs-renewal" && status.token) this.scheduleAt(this.now());
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  async getUsableToken(): Promise<string> {
    const status = this.dependencies.state.status();
    switch (status.kind) {
      case "action-required":
        throw new SsoActionRequiredError(blockedMessage(status.reason));
      case "renewal-blocked":
        // Renewal is blocked, but this token is still valid: serve it until it expires.
        return status.token.token;
      case "usable": {
        const remainingMs = status.token.expiresAtMs - this.now();
        if (remainingMs > this.dependencies.leadMs) {
          this.scheduleAt(status.token.expiresAtMs - this.dependencies.leadMs);
          return status.token.token;
        }
        if (remainingMs > RENEWAL_SAFETY_MS) {
          this.renewInBackground(status.token);
          return status.token.token;
        }
        return this.renewForeground(status.token);
      }
      case "needs-renewal":
        return this.renewForeground(status.token);
    }
  }

  private renewInBackground(previous: StoredToken): void {
    if (this.inFlight || this.now() < this.retryNotBeforeMs) return;
    void this.renew(previous).catch(() => undefined);
  }

  /** The caller needs a token now. Whatever the failure, serve a still-valid token if one exists. */
  private async renewForeground(previous: StoredToken | undefined): Promise<string> {
    try {
      return await this.renew(previous);
    } catch (error) {
      const status = this.dependencies.state.status();
      if (status.kind === "usable" || status.kind === "renewal-blocked") return status.token.token;
      if (status.kind === "action-required") throw new SsoActionRequiredError(blockedMessage(status.reason));
      const detail = error instanceof SsoLoginError ? ` (${error.message})` : "";
      throw new SsoUnavailableError(
        `TeamDynamix sign-in could not be renewed right now${detail}. Retry shortly, or run \`npm run login\`.`
      );
    }
  }

  private renew(previous: StoredToken | undefined): Promise<string> {
    if (!this.inFlight) {
      this.inFlight = this.attemptRenewal(previous).finally(() => {
        this.inFlight = undefined;
      });
    }
    return this.inFlight;
  }

  /** A renewal by a peer process (or by us a moment ago) already produced a fresh token. */
  private freshTokenFromPeer(previous: StoredToken | undefined): string | undefined {
    const status = this.dependencies.state.status();
    if (status.kind !== "usable") return undefined;
    if (status.token.token === previous?.token) return undefined;
    if (status.token.expiresAtMs - this.now() <= this.dependencies.leadMs) return undefined;
    this.scheduleAt(status.token.expiresAtMs - this.dependencies.leadMs);
    return status.token.token;
  }

  private async attemptRenewal(previous: StoredToken | undefined): Promise<string> {
    const { state, renewalLock } = this.dependencies;
    const epochAtStart = state.epoch();
    if (!renewalLock) return this.runRenewal(previous, epochAtStart);

    const waitMs = this.dependencies.peerWaitMs ?? PEER_WAIT_MS;
    const polls = Math.max(1, Math.ceil(waitMs / PEER_POLL_MS));
    for (let poll = 0; poll <= polls; poll += 1) {
      const release = renewalLock.tryAcquire();
      if (release) {
        try {
          // The peer may have finished between our decision to renew and getting the lock.
          const shared = this.freshTokenFromPeer(previous);
          if (shared) return shared;
          return await this.runRenewal(previous, epochAtStart);
        } finally {
          release();
        }
      }
      // Another process is renewing. Waiting for its result is not a failure.
      if (state.epoch() !== epochAtStart) throw new SsoRenewalDiscardedError();
      const shared = this.freshTokenFromPeer(previous);
      if (shared) return shared;
      await this.sleep(PEER_POLL_MS);
    }
    throw new SsoLoginError("Another process is renewing the TeamDynamix sign-in; try again shortly.", "transient");
  }

  private async runRenewal(previous: StoredToken | undefined, epochAtStart: number): Promise<string> {
    const { state, retries } = this.dependencies;
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0 && state.epoch() !== epochAtStart) throw new SsoRenewalDiscardedError();
      let session: SsoBrowserSession | undefined;
      try {
        this.dependencies.audit?.("renewal_started");
        session = await this.dependencies.openSession();
        const minted = await session.mintToken();
        const stored = await this.dependencies.validateToken(minted, previous);
        if (!state.commitRenewal(stored, epochAtStart)) {
          this.dependencies.audit?.("renewal_discarded");
          throw new SsoRenewalDiscardedError();
        }
        this.dependencies.audit?.("renewal_succeeded", { uid: stored.uid, expiresAtMs: stored.expiresAtMs });
        this.consecutiveFailures = 0;
        this.retryNotBeforeMs = 0;
        this.scheduleAt(stored.expiresAtMs - this.dependencies.leadMs);
        return stored.token;
      } catch (error) {
        if (error instanceof SsoRenewalDiscardedError) throw error;
        lastError = error;
        const kind = failureKind(error);
        this.dependencies.audit?.("renewal_failed", { kind });
        if (!isRetryable(kind)) {
          if (state.blockRenewal(kind, epochAtStart)) this.dependencies.audit?.("renewal_blocked", { kind });
          this.stop();
          throw error;
        }
        if (attempt < retries) {
          await this.sleep(backoffDelayMs(attempt, IN_CALL_BASE_MS, IN_CALL_CAP_MS, this.random));
        }
      } finally {
        await session?.close();
      }
    }

    this.scheduleRetryAfterTransientFailure();
    throw lastError;
  }

  /** Transient failures never block. They retry later with growing delay, but not past the token's expiry. */
  private scheduleRetryAfterTransientFailure(): void {
    const status = this.dependencies.state.status();
    if (status.kind !== "usable" && status.kind !== "needs-renewal") return;
    this.consecutiveFailures += 1;
    const delayMs = backoffDelayMs(this.consecutiveFailures - 1, RETRY_BASE_MS, RETRY_CAP_MS, this.random);
    const latestRetryMs =
      status.kind === "usable" ? status.token.expiresAtMs - RENEWAL_SAFETY_MS - this.now() : Number.POSITIVE_INFINITY;
    const boundedMs = Math.max(MIN_RETRY_MS, Math.min(delayMs, latestRetryMs));
    this.retryNotBeforeMs = this.now() + boundedMs;
    this.scheduleAt(this.retryNotBeforeMs);
  }

  private scheduleAt(whenMs: number): void {
    this.stop();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.getUsableToken().catch(() => undefined);
    }, Math.max(0, whenMs - this.now()));
    this.timer.unref?.();
  }
}
