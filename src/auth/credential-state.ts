import type { RealmLock } from "./realm-lock.js";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { StoredToken, TokenStore } from "../services/token-store.js";
import type { SsoFailureKind } from "./sso-errors.js";

/** Why automatic renewal is blocked. "signed-out" is an explicit logout. */
export type BlockReason = SsoFailureKind | "signed-out";

export interface CredentialStateFile {
  version: 1;
  /** Incremented by every login and sign-out; a renewal may only commit if it is unchanged. */
  epoch: number;
  renewal: "allowed" | "blocked";
  blockedReason?: BlockReason;
  blockedAtMs?: number;
}

export interface CredentialStatePersistence {
  read(): CredentialStateFile;
  write(state: CredentialStateFile): void;
}

const INITIAL_STATE: CredentialStateFile = { version: 1, epoch: 0, renewal: "allowed" };

export class MemoryStatePersistence implements CredentialStatePersistence {
  private current: CredentialStateFile = { ...INITIAL_STATE };
  read(): CredentialStateFile {
    return { ...this.current };
  }
  write(state: CredentialStateFile): void {
    this.current = { ...state };
  }
}

/**
 * Renewal state next to the token file. Unreadable state fails closed (renewal
 * blocked) so a damaged file can never silently re-enable a browser launch.
 * A legacy `.action-required` marker is migrated on first read.
 */
export class FileStatePersistence implements CredentialStatePersistence {
  constructor(
    private readonly path: string,
    private readonly legacyMarkerPath?: string
  ) {}

  read(): CredentialStateFile {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<CredentialStateFile>;
      if (
        parsed.version === 1 &&
        typeof parsed.epoch === "number" &&
        (parsed.renewal === "allowed" || parsed.renewal === "blocked")
      ) {
        return parsed as CredentialStateFile;
      }
      return { version: 1, epoch: 0, renewal: "blocked", blockedReason: "invalid-token" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return { version: 1, epoch: 0, renewal: "blocked", blockedReason: "invalid-token" };
      }
    }
    if (this.legacyMarkerPath && existsSync(this.legacyMarkerPath)) {
      const migrated: CredentialStateFile = {
        version: 1,
        epoch: 1,
        renewal: "blocked",
        blockedReason: "signed-out",
        blockedAtMs: Date.now(),
      };
      this.write(migrated);
      try {
        unlinkSync(this.legacyMarkerPath);
      } catch {
        // The state file now carries the block; a leftover marker is harmless.
      }
      return migrated;
    }
    return { ...INITIAL_STATE };
  }

  write(state: CredentialStateFile): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}

export function describeBlockReason(reason: BlockReason): string {
  switch (reason) {
    case "signed-out":
      return "you signed out";
    case "interaction-required":
      return "your organization's sign-in needs you to complete an interactive step (for example MFA)";
    case "identity-mismatch":
      return "the renewed sign-in belonged to a different TeamDynamix user";
    case "invalid-token":
      return "TeamDynamix no longer accepts the saved sign-in";
    case "configuration":
      return "silent renewal is not set up correctly on this machine";
    case "transient":
      return "renewal is temporarily unavailable";
  }
}

export type CredentialStatus =
  /** A valid token and renewal is allowed. */
  | { kind: "usable"; token: StoredToken }
  /** A valid token, but automatic renewal is blocked: serve it until it expires. */
  | { kind: "renewal-blocked"; token: StoredToken; reason: BlockReason }
  /** No valid token, renewal is allowed: a renewal is needed (token may be expired or absent). */
  | { kind: "needs-renewal"; token?: StoredToken }
  /** No valid token and renewal is blocked: only an interactive login can recover. */
  | { kind: "action-required"; reason: BlockReason };

/**
 * All sign-in state transitions live here. TokenStore is only persistence.
 * Only commitLogin() can move renewal from "blocked" to "allowed".
 */
export class CredentialState {
  constructor(
    private readonly store: TokenStore,
    private readonly persistence: CredentialStatePersistence,
    private readonly now: () => number = Date.now,
    /** Serialises state transitions across processes sharing one realm. */
    private readonly lock?: RealmLock
  ) {}

  private locked<T>(fn: () => T): T {
    return this.lock ? this.lock.withSync(fn) : fn();
  }

  currentToken(): StoredToken | undefined {
    return this.store.read();
  }

  epoch(): number {
    return this.persistence.read().epoch;
  }

  status(): CredentialStatus {
    const token = this.store.read();
    const state = this.persistence.read();
    const valid = token !== undefined && token.expiresAtMs > this.now();
    if (state.renewal === "blocked") {
      const reason = state.blockedReason ?? "signed-out";
      return valid ? { kind: "renewal-blocked", token, reason } : { kind: "action-required", reason };
    }
    return valid ? { kind: "usable", token } : { kind: "needs-renewal", ...(token ? { token } : {}) };
  }

  /** The one way back from "blocked": an interactive login (browser or paste). */
  commitLogin(token: StoredToken): void {
    this.locked(() => {
      const state = this.persistence.read();
      this.store.write(token);
      this.persistence.write({ version: 1, epoch: state.epoch + 1, renewal: "allowed" });
    });
  }

  /**
   * Stores a renewed token only if nothing changed since the renewal began:
   * same epoch (no login or logout) and renewal still allowed.
   */
  commitRenewal(token: StoredToken, epochAtStart: number): boolean {
    return this.locked(() => {
      const state = this.persistence.read();
      if (state.epoch !== epochAtStart || state.renewal !== "allowed") return false;
      this.store.write(token);
      return true;
    });
  }

  /** Blocks automatic renewal, unless a login or logout already moved the epoch. Never touches the token. */
  blockRenewal(reason: BlockReason, epochAtStart: number): boolean {
    return this.locked(() => {
      const state = this.persistence.read();
      if (state.epoch !== epochAtStart) return false;
      if (state.renewal === "blocked") return true;
      this.persistence.write({ ...state, renewal: "blocked", blockedReason: reason, blockedAtMs: this.now() });
      return true;
    });
  }

  /**
   * TeamDynamix rejected this exact token. Delete it and block renewal, but only
   * if it is still the stored token: a newer token written meanwhile is left alone.
   */
  revokeToken(token: string): boolean {
    return this.locked(() => {
      const current = this.store.read();
      if (!current || current.token !== token) return false;
      const state = this.persistence.read();
      this.store.clear();
      this.persistence.write({
        ...state,
        renewal: "blocked",
        blockedReason: "invalid-token",
        blockedAtMs: this.now(),
      });
      return true;
    });
  }

  signOut(): void {
    this.locked(() => {
      const state = this.persistence.read();
      this.store.clear();
      this.persistence.write({
        version: 1,
        epoch: state.epoch + 1,
        renewal: "blocked",
        blockedReason: "signed-out",
        blockedAtMs: this.now(),
      });
    });
  }
}
