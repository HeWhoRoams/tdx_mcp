import axios from "axios";
import { existsSync, rmSync } from "node:fs";
import { browserProfileDir } from "./paths.js";
import { openHermesCdpBrowserSession } from "./hermes-cdp-browser.js";
import { openLocalBrowserSession, type SsoBrowserSession } from "./sso-browser.js";
import { buildStoredToken, decodeJwtClaims, SsoLoginError, SsoPolicyError } from "./sso-login.js";
import { isRetryable, SsoActionRequiredError } from "./sso-errors.js";
import { SsoRenewalManager } from "./sso-renewal.js";
import {
  CredentialState,
  FileStatePersistence,
  MemoryStatePersistence,
  type BlockReason,
  type CredentialStatePersistence,
  type CredentialStatus,
} from "./credential-state.js";
import type { Config } from "../config.js";
import { SsoTokenStore, type StoredToken, type TokenStore } from "../services/token-store.js";

export interface SsoStatus {
  realm: string;
  expectedUser?: string;
  effectiveUid?: string;
  expiresAtMs?: number;
  state: CredentialStatus["kind"];
  blockedReason?: BlockReason;
}

export type SsoAuditEvent =
  | "login"
  | "renewal_started"
  | "renewal_succeeded"
  | "renewal_transient_failure"
  | "renewal_failed"
  | "renewal_discarded"
  | "action_required"
  | "identity_changed"
  | "token_revoked"
  | "logout";

/** What TeamDynamix said about a token it just answered 401 for. */
export type UnauthorizedVerdict = "permission-denied" | "expired" | "revoked" | "unknown";

/** Asks TeamDynamix whether it still accepts a token (GET /auth/getuser). */
export type SsoProbe = (token: string) => Promise<"ok" | "unauthorized" | "unknown">;

export interface SsoLifecycleOverrides {
  probe?: SsoProbe;
  persistence?: CredentialStatePersistence;
  openRenewalSession?: () => Promise<SsoBrowserSession>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** The only credential interface given to the TeamDynamix transport. */
export interface SsoAuthorization {
  authorization(): Promise<string>;
  handleUnauthorized(token: string): Promise<UnauthorizedVerdict>;
}

const PROBE_SUCCESS_TTL_MS = 60_000;

function defaultProbe(apiBaseUrl: string): SsoProbe {
  return async (token) => {
    try {
      await axios.get(`${apiBaseUrl.replace(/\/+$/, "")}/auth/getuser`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 15_000,
        maxRedirects: 0,
      });
      return "ok";
    } catch (error) {
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      return status === 401 || (status !== undefined && status >= 300 && status < 400) ? "unauthorized" : "unknown";
    }
  };
}

/** Deep lifecycle module for one realm and Expected user. */
export class SsoLifecycle implements SsoAuthorization {
  private readonly renewal: SsoRenewalManager;
  private readonly auth: Extract<Config["auth"], { method: "sso" }>;
  private readonly config: Config;
  private readonly state: CredentialState;
  private readonly probe: SsoProbe;
  private readonly now: () => number;
  private lastProbeOk: { token: string; atMs: number } | undefined;
  private readonly overrides: SsoLifecycleOverrides;

  constructor(
    config: Config,
    store: TokenStore,
    private readonly audit: (event: SsoAuditEvent, fields?: Record<string, unknown>) => void,
    overrides: SsoLifecycleOverrides = {}
  ) {
    this.config = config;
    this.overrides = overrides;
    this.now = overrides.now ?? Date.now;
    this.probe = overrides.probe ?? defaultProbe(config.apiBaseUrl);
    const persistence =
      overrides.persistence ??
      (store instanceof SsoTokenStore
        ? new FileStatePersistence(store.statePath, store.legacyMarkerPath)
        : new MemoryStatePersistence());
    this.state = new CredentialState(store, persistence, this.now);
    this.auth = config.auth as Extract<Config["auth"], { method: "sso" }>;
    this.renewal = new SsoRenewalManager({
      state: this.state,
      leadMs: this.auth.renewLeadMs,
      retries: this.auth.renewRetries,
      now: this.now,
      ...(overrides.sleep ? { sleep: overrides.sleep } : {}),
      openSession: () => this.openRenewalSession(),
      // Renewal must not change who is signed in; only an interactive login may.
      validateToken: (token, previous) => this.validate(token, previous, true),
      audit: (event, fields) => {
        if (event === "renewal_failed") {
          const retryable = isRetryable(fields?.kind as Parameters<typeof isRetryable>[0]);
          this.audit(retryable ? "renewal_transient_failure" : "renewal_failed", fields);
        } else if (event === "renewal_blocked") this.audit("action_required", fields);
        else this.audit(event, fields);
      },
    });
  }

  start(): void {
    this.renewal.start();
  }
  stop(): void {
    this.renewal.stop();
  }

  async authorization(): Promise<string> {
    try {
      return await this.renewal.getUsableToken();
    } catch (error) {
      if (error instanceof SsoActionRequiredError) this.audit("action_required");
      throw error;
    }
  }

  /**
   * TeamDynamix answers 401 both for an expired token and for "you may not do that".
   * Ask getuser which. Only a token TeamDynamix itself rejects is deleted, and only
   * if it is still the stored one; a timeout or 5xx never costs the user their token.
   */
  async handleUnauthorized(token: string): Promise<UnauthorizedVerdict> {
    const exp = decodeJwtClaims(token)?.exp;
    if (typeof exp === "number" && exp * 1000 <= this.now()) return "expired";
    if (this.lastProbeOk?.token === token && this.now() - this.lastProbeOk.atMs < PROBE_SUCCESS_TTL_MS) {
      return "permission-denied";
    }
    const result = await this.probe(token);
    if (result === "ok") {
      this.lastProbeOk = { token, atMs: this.now() };
      return "permission-denied";
    }
    if (result === "unauthorized") {
      this.lastProbeOk = undefined;
      if (this.state.revokeToken(token)) {
        this.renewal.stop();
        this.audit("token_revoked");
      }
      return "revoked";
    }
    return "unknown";
  }

  status(): SsoStatus {
    const status = this.state.status();
    const token = "token" in status ? status.token : undefined;
    return {
      realm: this.config.apiBaseUrl,
      ...(this.auth.expectedUser ? { expectedUser: this.auth.expectedUser } : {}),
      ...(token?.uid ? { effectiveUid: token.uid } : {}),
      ...(token ? { expiresAtMs: token.expiresAtMs } : {}),
      state: status.kind,
      ...(status.kind === "renewal-blocked" || status.kind === "action-required"
        ? { blockedReason: status.reason }
        : {}),
    };
  }

  async login(): Promise<StoredToken> {
    const session = await this.openInteractiveSession();
    try {
      return await this.accept(await session.mintToken(), "sso");
    } finally {
      await session.close();
    }
  }

  async accept(token: string, method: "sso" | "paste"): Promise<StoredToken> {
    const previous = this.state.currentToken();
    const stored = await this.validate(token, previous, false);
    if (previous?.uid !== undefined && stored.uid !== undefined && previous.uid !== stored.uid) {
      this.audit("identity_changed", { fromUid: previous.uid, toUid: stored.uid });
    }
    this.state.commitLogin({ ...stored, method });
    this.lastProbeOk = undefined;
    this.audit("login", { uid: stored.uid, expiresAtMs: stored.expiresAtMs, method });
    return stored;
  }

  signOut(full = false): void {
    this.stop();
    this.state.signOut();
    this.lastProbeOk = undefined;
    if (full && this.auth.deployment === "local") {
      rmSync(browserProfileDir(this.config.apiBaseUrl, this.auth.expectedUser), { recursive: true, force: true });
    }
    this.audit("logout", { full, deployment: this.auth.deployment });
  }

  private async validate(token: string, previous: StoredToken | undefined, renewal: boolean): Promise<StoredToken> {
    return buildStoredToken(token, this.config.apiBaseUrl, {
      ...(this.auth.expectedUser ? { expectedUser: this.auth.expectedUser } : {}),
      method: "sso",
      ...(previous ? { previous } : {}),
      ...(renewal ? { requireSameUser: true } : {}),
    });
  }

  private openInteractiveSession(): Promise<SsoBrowserSession> {
    if (this.auth.deployment === "external") {
      return openHermesCdpBrowserSession({
        apiBaseUrl: this.config.apiBaseUrl,
        cdpEndpoint: this.auth.cdpEndpoint!,
        timeoutMs: 5 * 60_000,
      });
    }
    return openLocalBrowserSession({
      apiBaseUrl: this.config.apiBaseUrl,
      browser: this.auth.browser,
      profileDir: browserProfileDir(this.config.apiBaseUrl, this.auth.expectedUser),
      headless: false,
      timeoutMs: 5 * 60_000,
    });
  }

  private openRenewalSession(): Promise<SsoBrowserSession> {
    if (this.overrides.openRenewalSession) return this.overrides.openRenewalSession();
    if (this.auth.deployment === "external") {
      return openHermesCdpBrowserSession({
        apiBaseUrl: this.config.apiBaseUrl,
        cdpEndpoint: this.auth.cdpEndpoint!,
        timeoutMs: 30_000,
      });
    }
    const profileDir = browserProfileDir(this.config.apiBaseUrl, this.auth.expectedUser);
    if (!existsSync(profileDir)) {
      throw new SsoPolicyError("No saved local SSO browser session is available. Run `npm run login` to sign in first.");
    }
    return openLocalBrowserSession({
      apiBaseUrl: this.config.apiBaseUrl,
      browser: this.auth.browser,
      profileDir,
      headless: true,
      timeoutMs: 30_000,
    });
  }
}

export function createSsoLifecycle(
  config: Config,
  store: TokenStore,
  audit: (event: SsoAuditEvent, fields?: Record<string, unknown>) => void,
  overrides: SsoLifecycleOverrides = {}
): SsoLifecycle {
  if (config.auth.method !== "sso") throw new SsoLoginError("SSO lifecycle requires SSO authentication.");
  return new SsoLifecycle(config, store, audit, overrides);
}
