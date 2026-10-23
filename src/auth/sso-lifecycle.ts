import type { TokenSource } from "./sso-types.js";
import { createHash } from "node:crypto";
import { RealmLock } from "./realm-lock.js";
import axios from "axios";
import { existsSync, rmSync } from "node:fs";
import { bindingDigest, bindingOf, type IdentityBinding } from "./identity-binding.js";
import { migrateLegacyState, type MigrationOutcome } from "./legacy-migration.js";
import { browserProfileDir, ssoTokenPath } from "./paths.js";
import { openHermesCdpBrowserSession } from "./hermes-cdp-browser.js";
import { openLocalBrowserSession, type SsoBrowserSession } from "./sso-browser.js";
import { buildStoredToken, decodeJwtClaims, ssoLoginRequiredMessage, SsoLoginError, SsoPolicyError } from "./sso-login.js";
import { isRetryable, SsoActionRequiredError, SsoRenewalDiscardedError, SsoUnavailableError } from "./sso-errors.js";
import { SsoRenewalManager } from "./sso-renewal.js";
import {
  CredentialState,
  FileStatePersistence,
  type BlockReason,
  type CredentialStatePersistence,
  type CredentialStatus,
} from "./credential-state.js";
import { getTdxHome, type SsoConfig } from "../config.js";
import { SsoTokenStore, type StoredToken } from "../services/token-store.js";

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
  | "state_migrated"
  | "state_migration_skipped"
  | "logout";

/** What a sign-out did, so callers can tell the person what is still theirs to do. */
export interface SignOutResult {
  removedLocalProfile: boolean;
  operatorAction?: string;
}

/** What TeamDynamix said about a token it just answered 401 for. */
export type UnauthorizedVerdict = "permission-denied" | "expired" | "revoked" | "unknown";

/**
 * What the HTTP client sees of SSO. It never receives the token itself, only a ready
 * Authorization header and a fingerprint to report a rejected request with.
 */
export interface SsoAuthorization {
  authorize(): Promise<{ header: string; fingerprint: string }>;
  reportUnauthorized(fingerprint: string): Promise<UnauthorizedVerdict>;
  stop(): void;
}

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
  private readonly issued = new Map<string, string>();
  private readonly renewalLock: RealmLock;
  private readonly renewal: SsoRenewalManager;
  private readonly auth: SsoConfig["auth"];
  private readonly config: SsoConfig;
  private readonly state: CredentialState;
  private readonly probe: SsoProbe;
  private readonly now: () => number;
  private lastProbeOk: { token: string; atMs: number } | undefined;
  private readonly overrides: SsoLifecycleOverrides;
  private readonly binding: IdentityBinding;

  constructor(
    config: SsoConfig,
    store: SsoTokenStore,
    private readonly audit: (event: SsoAuditEvent, fields?: Record<string, unknown>) => void,
    overrides: SsoLifecycleOverrides = {}
  ) {
    this.config = config;
    this.binding = bindingOf(config.apiBaseUrl, config.auth.expectedUser);
    this.overrides = overrides;
    this.now = overrides.now ?? Date.now;
    this.probe = overrides.probe ?? defaultProbe(config.apiBaseUrl);
    const persistence = overrides.persistence ?? new FileStatePersistence(store.statePath, store.legacyMarkerPath);
    this.renewalLock = new RealmLock(store.renewLockPath);
    this.state = new CredentialState(store, persistence, this.now, new RealmLock(store.lockPath));
    this.auth = config.auth;
    this.renewal = new SsoRenewalManager({
      state: this.state,
      renewalLock: this.renewalLock,
      leadMs: this.auth.renewLeadMs,
      retries: this.auth.renewRetries,
      now: this.now,
      ...(overrides.sleep ? { sleep: overrides.sleep } : {}),
      openSession: () => this.openSession({ interactive: false }),
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
    // Migration may need one network round trip, so renewal scheduling waits for it (never fails start).
    void this.migrateLegacyState()
      .catch(() => undefined)
      .then(() => this.renewal.start());
  }

  /** Carries a first-release sign-in forward only if it is verified as the Expected user. */
  migrateLegacyState(): Promise<MigrationOutcome> {
    return migrateLegacyState({
      binding: this.binding,
      stateHome: getTdxHome(),
      tokenPath: ssoTokenPath(this.binding),
      currentProfileDir: browserProfileDir(this.binding),
      isPristine: () => this.state.isPristine(),
      validate: (token) => this.validate(token, undefined, false),
      commit: (token) => this.state.commitLogin({ ...token, method: token.method ?? "sso" }),
      audit: (event, fields) => this.audit(event, fields),
    });
  }
  stop(): void {
    this.renewal.stop();
  }

  async authorize(): Promise<{ header: string; fingerprint: string }> {
    try {
      const token = await this.authorization();
      const fingerprint = createHash("sha256").update(token).digest("hex").slice(0, 16);
      this.issued.delete(fingerprint);
      this.issued.set(fingerprint, token);
      if (this.issued.size > 8) this.issued.delete(this.issued.keys().next().value as string);
      return { header: `Bearer ${token}`, fingerprint };
    } catch (error) {
      if (error instanceof SsoActionRequiredError) {
        const hint = ssoLoginRequiredMessage(this.config.apiBaseUrl, this.state.currentToken());
        throw new SsoActionRequiredError(`${hint} ${error.message}`.trim());
      }
      if (error instanceof SsoUnavailableError) throw error;
      // Anything else (a lock timeout, a renewal discarded by a concurrent login or logout) is not
      // something `npm run login` fixes; the caller can simply retry.
      throw new SsoUnavailableError(
        `TeamDynamix sign-in state was busy or changed just now; retry shortly. ${error instanceof Error ? error.message : ""}`.trim()
      );
    }
  }

  /**
   * Compatibility gate only: renews now, ignoring token freshness, but still through the renewal
   * lock, identity validation and the epoch check, so it can never do what a real renewal may not.
   */
  async forceRenewal(): Promise<{ uid?: string; expiresAtMs: number; fingerprint: string }> {
    const handle = this.renewalLock.tryAcquire();
    if (!handle) throw new SsoUnavailableError("Another process is renewing the sign-in.");
    try {
      const epochAtStart = this.state.epoch();
      const previous = this.state.currentToken();
      const session = await this.openSession({ interactive: false });
      let minted: string;
      try {
        minted = await session.mintToken();
      } finally {
        await session.close();
      }
      const stored = await this.validate(minted, previous, true);
      if (!this.state.commitRenewal(stored, epochAtStart)) throw new SsoRenewalDiscardedError();
      return {
        ...(stored.uid ? { uid: stored.uid } : {}),
        expiresAtMs: stored.expiresAtMs,
        fingerprint: createHash("sha256").update(stored.token).digest("hex").slice(0, 16),
      };
    } finally {
      handle.release();
    }
  }

  /** A fingerprint we no longer hold belongs to an older token; the caller simply retries. */
  async reportUnauthorized(fingerprint: string): Promise<UnauthorizedVerdict> {
    const token = this.issued.get(fingerprint);
    return token === undefined ? "expired" : this.handleUnauthorized(token);
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

  /**
   * Isolates cached data per realm, expected user and signed-in person. Undefined until a
   * validated token is stored, so nothing is attributed to an unverified identity.
   */
  cacheNamespace(): string | undefined {
    const uid = this.state.currentToken()?.uid;
    return uid ? `${bindingDigest(this.binding)}:${uid}` : undefined;
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
    const session = await this.openSession({ interactive: true });
    try {
      return await this.accept(await session.mintToken(), "sso");
    } finally {
      await session.close();
    }
  }

  async accept(token: string, method: TokenSource): Promise<StoredToken> {
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

  signOut(full = false): SignOutResult {
    this.stop();
    this.state.signOut();
    this.lastProbeOk = undefined;
    const removedLocalProfile = full && this.auth.deployment === "local";
    if (removedLocalProfile) rmSync(browserProfileDir(this.binding), { recursive: true, force: true });
    this.audit("logout", { full, deployment: this.auth.deployment });
    // In an external deployment the IdP session lives in a browser we do not own, so we cannot end it.
    return {
      removedLocalProfile,
      ...(full && this.auth.deployment === "external"
        ? { operatorAction: "Ask the Hermes operator to sign the workspace browser out of SSO; this server cannot." }
        : {}),
    };
  }

  private async validate(token: string, previous: StoredToken | undefined, renewal: boolean): Promise<StoredToken> {
    if (renewal && previous?.uid === undefined && !this.auth.expectedUser) {
      // Nothing to pin the user to. A first sign-in with no Expected user must be a person's own login.
      throw new SsoLoginError(
        "There is no saved sign-in to renew from and no Expected user is configured. Run `npm run login`.",
        "interaction-required"
      );
    }
    return buildStoredToken(token, this.config.apiBaseUrl, {
      ...(this.auth.expectedUser ? { expectedUser: this.auth.expectedUser } : {}),
      method: "sso",
      ...(previous ? { previous } : {}),
      ...(renewal ? { requireSameUser: true } : {}),
    });
  }

  /** One place that knows how each deployment opens a sign-in browser. */
  private openSession({ interactive }: { interactive: boolean }): Promise<SsoBrowserSession> {
    if (!interactive && this.overrides.openRenewalSession) return this.overrides.openRenewalSession();
    const timeoutMs = interactive ? 5 * 60_000 : 30_000;
    if (this.auth.deployment === "external") {
      return openHermesCdpBrowserSession({
        apiBaseUrl: this.config.apiBaseUrl,
        cdpEndpoint: this.auth.cdpEndpoint!,
        timeoutMs,
      });
    }
    const profileDir = browserProfileDir(this.binding);
    if (!interactive && !existsSync(profileDir)) {
      throw new SsoPolicyError("No saved local SSO browser session is available. Run `npm run login` to sign in first.");
    }
    return openLocalBrowserSession({
      apiBaseUrl: this.config.apiBaseUrl,
      browser: this.auth.browser,
      profileDir,
      headless: !interactive,
      timeoutMs,
    });
  }
}
