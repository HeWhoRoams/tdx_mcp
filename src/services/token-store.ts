import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig } from "../config.js";
import { logger } from "./logger.js";

export interface StoredToken {
  token: string;
  expiresAtMs: number;
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

export function createTokenStore(): TokenStore {
  const config = getConfig();
  return config.tokenCache === "file"
    ? new FileTokenStore(`${config.apiBaseUrl}|${config.authCacheKey}`)
    : new MemoryTokenStore();
}
