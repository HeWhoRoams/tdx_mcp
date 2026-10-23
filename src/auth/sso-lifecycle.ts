import { existsSync, rmSync } from "node:fs";
import { browserProfileDir } from "./paths.js";
import { openHermesCdpBrowserSession } from "./hermes-cdp-browser.js";
import { openLocalBrowserSession, type SsoBrowserSession } from "./sso-browser.js";
import { buildStoredToken, SsoLoginError, SsoPolicyError } from "./sso-login.js";
import { SsoRenewalManager } from "./sso-renewal.js";
import { CredentialState } from "./credential-state.js";
import type { Config } from "../config.js";
import type { StoredToken, TokenStore } from "../services/token-store.js";

export interface SsoStatus {
  realm: string;
  expectedUser?: string;
  effectiveUid?: string;
  expiresAtMs?: number;
  state: "usable" | "action-required";
}

export type SsoAuditEvent = "login" | "renewal_started" | "renewal_succeeded" | "renewal_transient_failure" | "action_required" | "logout";

/** The only credential interface given to the TeamDynamix transport. */
export interface SsoAuthorization {
  authorization(): Promise<string>;
}

/** Deep lifecycle module for one realm and Expected user. */
export class SsoLifecycle implements SsoAuthorization {
  private readonly renewal: SsoRenewalManager;
  private readonly auth: Extract<Config["auth"], { method: "sso" }>;
  private readonly config: Config;
  private readonly state: CredentialState;

  constructor(config: Config, private readonly store: TokenStore, private readonly audit: (event: SsoAuditEvent, fields?: Record<string, unknown>) => void) {
    this.config = config;
    this.state = new CredentialState(store);
    this.auth = config.auth as Extract<Config["auth"], { method: "sso" }>;
    this.renewal = new SsoRenewalManager({
      store,
      leadMs: this.auth.renewLeadMs,
      retries: this.auth.renewRetries,
      openSession: () => this.openRenewalSession(),
      validateToken: (token, previous) => this.validate(token, previous),
      audit: (event, fields) => this.audit(
        event === "renewal_failed" ? (fields?.reason === "policy" ? "action_required" : "renewal_transient_failure") : event,
        fields
      ),
    });
  }

  start(): void { this.renewal.start(); }
  stop(): void { this.renewal.stop(); }

  async authorization(): Promise<string> {
    try { return await this.renewal.getUsableToken(); }
    catch (error) { this.audit("action_required"); throw error; }
  }

  status(): SsoStatus {
    const token = this.state.current();
    const actionRequired = this.state.state() === "action-required";
    return { realm: this.config.apiBaseUrl, ...(this.auth.expectedUser ? { expectedUser: this.auth.expectedUser } : {}), ...(token?.uid ? { effectiveUid: token.uid } : {}), ...(token ? { expiresAtMs: token.expiresAtMs } : {}), state: actionRequired ? "action-required" : "usable" };
  }

  async login(): Promise<StoredToken> {
    const session = await this.openInteractiveSession();
    try { return await this.accept(await session.mintToken(), "sso"); }
    finally { await session.close(); }
  }

  async accept(token: string, method: "sso" | "paste"): Promise<StoredToken> {
    const stored = await this.validate(token, this.state.current());
    this.state.replace({ ...stored, method });
    this.audit("login", { uid: stored.uid, expiresAtMs: stored.expiresAtMs, method });
    return stored;
  }

  signOut(full = false): void {
    this.stop();
    this.state.signOut();
    if (full && this.auth.deployment === "local") rmSync(browserProfileDir(this.config.apiBaseUrl, this.auth.expectedUser), { recursive: true, force: true });
    this.audit("logout", { full, deployment: this.auth.deployment });
  }

  private async validate(token: string, previous?: StoredToken): Promise<StoredToken> {
    return buildStoredToken(token, this.config.apiBaseUrl, { ...(this.auth.expectedUser ? { expectedUser: this.auth.expectedUser } : {}), method: "sso", ...(previous ? { previous } : {}) });
  }

  private openInteractiveSession(): Promise<SsoBrowserSession> {
    if (this.auth.deployment === "external") return openHermesCdpBrowserSession({ apiBaseUrl: this.config.apiBaseUrl, cdpEndpoint: this.auth.cdpEndpoint!, timeoutMs: 5 * 60_000 });
    return openLocalBrowserSession({ apiBaseUrl: this.config.apiBaseUrl, browser: this.auth.browser, profileDir: browserProfileDir(this.config.apiBaseUrl, this.auth.expectedUser), headless: false, timeoutMs: 5 * 60_000 });
  }

  private openRenewalSession(): Promise<SsoBrowserSession> {
    if (this.auth.deployment === "external") return openHermesCdpBrowserSession({ apiBaseUrl: this.config.apiBaseUrl, cdpEndpoint: this.auth.cdpEndpoint!, timeoutMs: 30_000 });
    const profileDir = browserProfileDir(this.config.apiBaseUrl, this.auth.expectedUser);
    if (!existsSync(profileDir)) throw new SsoPolicyError("No saved local SSO browser session is available. Run `npm run login` to sign in first.");
    return openLocalBrowserSession({ apiBaseUrl: this.config.apiBaseUrl, browser: this.auth.browser, profileDir, headless: true, timeoutMs: 30_000 });
  }
}

export function createSsoLifecycle(config: Config, store: TokenStore, audit: (event: SsoAuditEvent, fields?: Record<string, unknown>) => void): SsoLifecycle {
  if (config.auth.method !== "sso") throw new SsoLoginError("SSO lifecycle requires SSO authentication.");
  return new SsoLifecycle(config, store, audit);
}
