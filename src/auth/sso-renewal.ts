import type { SsoBrowserSession } from "./sso-browser.js";
import { SsoLoginError } from "./sso-login.js";
import type { StoredToken, TokenStore } from "../services/token-store.js";

export class SsoActionRequiredError extends Error {}

export interface SsoRenewalDependencies {
  store: TokenStore;
  leadMs: number;
  retries: number;
  openSession(): Promise<SsoBrowserSession>;
  validateToken(token: string, previous?: StoredToken): Promise<StoredToken>;
  audit?(event: "renewal_started" | "renewal_succeeded" | "renewal_failed", fields?: Record<string, unknown>): void;
  now?: () => number;
}

interface AutomaticRenewalControl {
  isAutomaticRenewalAllowed?(): boolean;
  blockAutomaticRenewal?(): void;
}

/** Owns one realm's validated SSO token and makes renewal single-flight. */
export class SsoRenewalManager {
  private readonly now: () => number;
  private inFlight: Promise<string> | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly dependencies: SsoRenewalDependencies) {
    this.now = dependencies.now ?? Date.now;
  }

  start(): void {
    this.schedule(this.dependencies.store.read());
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  async getUsableToken(): Promise<string> {
    if (!this.isAutomaticRenewalAllowed()) {
      throw new SsoActionRequiredError("TeamDynamix sign-in required: run `npm run login` before retrying.");
    }
    const current = this.dependencies.store.read();
    const now = this.now();
    if (current && current.expiresAtMs > now && current.expiresAtMs - now > this.dependencies.leadMs) {
      this.schedule(current);
      return current.token;
    }

    try {
      return await this.renew(current);
    } catch (error) {
      if (error instanceof SsoLoginError) {
        this.blockAutomaticRenewal();
        this.stop();
        throw new SsoActionRequiredError(
          `TeamDynamix sign-in required: ${error.message} Run \`npm run login\` before retrying.`
        );
      }
      if (current && current.expiresAtMs > now) {
        this.schedule(current, 60_000);
        return current.token;
      }
      throw new SsoActionRequiredError(
        `TeamDynamix sign-in required: silent SSO renewal could not complete. ${
          error instanceof Error ? error.message : "Complete the approved SSO sign-in flow, then retry."
        }`
      );
    }
  }

  private isAutomaticRenewalAllowed(): boolean {
    return (this.dependencies.store as TokenStore & AutomaticRenewalControl).isAutomaticRenewalAllowed?.() ?? true;
  }

  private blockAutomaticRenewal(): void {
    (this.dependencies.store as TokenStore & AutomaticRenewalControl).blockAutomaticRenewal?.();
  }

  private async renew(previous: StoredToken | undefined): Promise<string> {
    if (!this.inFlight) {
      this.inFlight = this.runRenewal(previous).finally(() => {
        this.inFlight = undefined;
      });
    }
    return this.inFlight;
  }

  private async runRenewal(previous: StoredToken | undefined): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.dependencies.retries; attempt += 1) {
      let session: SsoBrowserSession | undefined;
      try {
        this.dependencies.audit?.("renewal_started");
        session = await this.dependencies.openSession();
        const minted = await session.mintToken();
        const stored = await this.dependencies.validateToken(minted, previous);
        this.dependencies.store.write(stored);
        this.dependencies.audit?.("renewal_succeeded", { uid: stored.uid, expiresAtMs: stored.expiresAtMs });
        this.schedule(stored);
        return stored.token;
      } catch (error) {
        lastError = error;
        this.dependencies.audit?.("renewal_failed", {
          reason: error instanceof SsoLoginError ? "policy" : "transient",
        });
        if (error instanceof SsoLoginError) break;
      } finally {
        await session?.close();
      }
    }
    throw lastError;
  }

  private schedule(token: StoredToken | undefined, minimumDelayMs = 0): void {
    this.stop();
    if (!token) return;
    const delayMs = Math.max(minimumDelayMs, token.expiresAtMs - this.now() - this.dependencies.leadMs);
    this.timer = setTimeout(() => {
      void this.getUsableToken().catch(() => undefined);
    }, delayMs);
    this.timer.unref?.();
  }
}
