import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, renameSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getConfig } from "../config.js";
import { logger } from "./logger.js";
import { resetCaches } from "./cache.js";
import { bindingOf } from "../auth/identity-binding.js";
import { ssoTokenPath } from "../auth/paths.js";

export interface StoredToken {
  token: string;
  expiresAtMs: number;
  /** Set for SSO tokens: who the token belongs to, as confirmed by /auth/getuser. */
  uid?: string;
  username?: string;
  fullName?: string;
  email?: string;
  entity?: string;
  partition?: string;
  apiBaseUrl?: string;
  obtainedAtMs?: number;
  method?: "sso" | "paste";
}

export interface TokenStore {
  read(): StoredToken | undefined;
  write(token: StoredToken): void;
  clear(): void;
}

class MemoryTokenStore implements TokenStore {
  private current: StoredToken | undefined;
  read() {
    return this.current;
  }
  write(token: StoredToken) {
    this.current = token;
  }
  clear() {
    this.current = undefined;
  }
}

/**
 * Persists the JWT across short-lived processes (CLI scripts, one-shot stdio
 * sessions) so each invocation does not pay a full login round trip. Opt-in via
 * TEAMDYNAMIX_TOKEN_CACHE=file because it writes a bearer token to disk.
 */
class FileTokenStore implements TokenStore {
  private memory = new MemoryTokenStore();
  private readonly path: string;

  constructor(cacheKey: string) {
    const digest = createHash("sha256").update(cacheKey).digest("hex").slice(0, 32);
    const dir = join(tmpdir(), "tdx-mcp");
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {
      // Fall through; write() reports the real failure.
    }
    this.path = join(dir, `token-${digest}.json`);
  }

  read(): StoredToken | undefined {
    const cached = this.memory.read();
    if (cached) return cached;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as StoredToken;
      if (typeof parsed.token !== "string" || typeof parsed.expiresAtMs !== "number") return undefined;
      this.memory.write(parsed);
      return parsed;
    } catch {
      return undefined;
    }
  }

  write(token: StoredToken): void {
    this.memory.write(token);
    try {
      writeFileSync(this.path, JSON.stringify(token), { mode: 0o600 });
    } catch (error) {
      logger.warn("could not persist token cache", { error: String(error) });
    }
  }

  clear(): void {
    this.memory.clear();
    try {
      unlinkSync(this.path);
    } catch {
      // Nothing cached on disk.
    }
  }
}

/**
 * Per-user SSO token on disk (pure persistence: sign-in state transitions live in CredentialState). The login CLI writes it while the server may be
 * running, so read() reloads whenever the file's mtime changes (a fresh
 * `npm run login` takes effect with no restart). If the owner of the token
 * changes, every cache is purged so one identity's results never reach another.
 */
export class SsoTokenStore implements TokenStore {
  private current: StoredToken | undefined;
  private seenMtimeMs = -1;
  private lastUid: string | undefined;

  constructor(private readonly path: string) {}

  /** Renewal state (epoch, blocked or allowed) lives beside the token, owned by CredentialState. */
  get statePath(): string {
    return `${this.path}.state.json`;
  }

  /** Short critical sections (commit, revoke, sign-out) take this lock. */
  get lockPath(): string {
    return `${this.path}.lock`;
  }

  /** Held for the whole of a renewal so only one process opens the shared browser profile. */
  get renewLockPath(): string {
    return `${this.path}.renew.lock`;
  }

  /** Marker written by the first SSO release; migrated into the state file on first read. */
  get legacyMarkerPath(): string {
    return `${this.path}.action-required`;
  }

  read(): StoredToken | undefined {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(this.path).mtimeMs;
    } catch {
      this.current = undefined;
      this.seenMtimeMs = -1;
      return undefined;
    }
    if (mtimeMs !== this.seenMtimeMs) {
      try {
        const parsed = JSON.parse(readFileSync(this.path, "utf8")) as StoredToken;
        if (typeof parsed.token !== "string" || typeof parsed.expiresAtMs !== "number") return undefined;
        if (this.lastUid !== undefined && parsed.uid !== undefined && parsed.uid !== this.lastUid) {
          logger.info("signed-in TeamDynamix user changed; purging caches");
          resetCaches();
        }
        this.current = parsed;
        this.seenMtimeMs = mtimeMs;
        if (parsed.uid !== undefined) this.lastUid = parsed.uid;
      } catch {
        this.current = undefined;
        return undefined;
      }
    }
    return this.current;
  }

  write(token: StoredToken): void {
    const previousUid = this.lastUid;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(token), { mode: 0o600 });
    renameSync(tmp, this.path);
    this.current = token;
    this.seenMtimeMs = statSync(this.path).mtimeMs;
    if (previousUid !== undefined && token.uid !== undefined && token.uid !== previousUid) {
      logger.info("signed-in TeamDynamix user changed; purging caches");
      resetCaches();
    }
    if (token.uid !== undefined) this.lastUid = token.uid;
  }

  clear(): void {
    this.current = undefined;
    this.seenMtimeMs = -1;
    try {
      unlinkSync(this.path);
    } catch {
      // Nothing stored.
    }
  }
}

export function createTokenStore(): TokenStore {
  const config = getConfig();
  if (config.auth.method === "sso") return new SsoTokenStore(ssoTokenPath(bindingOf(config.apiBaseUrl, config.auth.expectedUser)));
  return createServiceTokenStore();
}

/** Token storage for admin and user logins. SSO state is built by the composition root instead. */
export function createServiceTokenStore(): TokenStore {
  const config = getConfig();
  return config.tokenCache === "file"
    ? new FileTokenStore(`${config.apiBaseUrl}|${config.authCacheKey}`)
    : new MemoryTokenStore();
}
