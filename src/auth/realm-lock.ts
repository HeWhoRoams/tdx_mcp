import { randomBytes } from "node:crypto";
import { mkdirSync, openSync, closeSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { dirname } from "node:path";

export interface RealmLockOptions {
  /** A lock older than this is considered abandoned. */
  staleMs?: number;
  now?: () => number;
  pid?: number;
  hostname?: string;
  isAlive?: (pid: number) => boolean;
}

interface LockBody {
  pid: number;
  hostname: string;
  acquiredAtMs: number;
  nonce: string;
}

export const DEFAULT_LOCK_STALE_MS = 2 * 60_000;

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Blocks the thread without spinning; only used for the short critical sections below. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Cross-process mutual exclusion for one realm, built on an exclusive-create lock file.
 * A holder that crashed leaves a file behind; it is taken over once its process is gone
 * (same host) or the file is older than `staleMs`.
 */
export class RealmLock {
  private readonly staleMs: number;
  private readonly now: () => number;
  private readonly pid: number;
  private readonly host: string;
  private readonly isAlive: (pid: number) => boolean;

  constructor(
    private readonly path: string,
    options: RealmLockOptions = {}
  ) {
    this.staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;
    this.now = options.now ?? Date.now;
    this.pid = options.pid ?? process.pid;
    this.host = options.hostname ?? osHostname();
    this.isAlive = options.isAlive ?? processIsAlive;
  }

  /** Takes the lock if it is free (or abandoned). Returns a release function, or undefined when busy. */
  tryAcquire(): (() => void) | undefined {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const nonce = randomBytes(8).toString("hex");
      const body: LockBody = { pid: this.pid, hostname: this.host, acquiredAtMs: this.now(), nonce };
      try {
        const fd = openSync(this.path, "wx", 0o600);
        try {
          writeSync(fd, JSON.stringify(body));
        } finally {
          closeSync(fd);
        }
        return () => this.release(nonce);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (!this.isStale()) return undefined;
        this.removeStale();
      }
    }
    return undefined;
  }

  /** Runs `fn` while holding the lock, waiting up to `waitMs` for it. Throws if it cannot be taken. */
  withSync<T>(fn: () => T, { waitMs = 5_000, pollMs = 50 }: { waitMs?: number; pollMs?: number } = {}): T {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const release = this.tryAcquire();
      if (release) {
        try {
          return fn();
        } finally {
          release();
        }
      }
      if (Date.now() >= deadline) throw new Error("Timed out waiting for the TeamDynamix sign-in state lock.");
      sleepSync(pollMs);
    }
  }

  private read(): LockBody | undefined {
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as LockBody;
    } catch {
      return undefined;
    }
  }

  private isStale(): boolean {
    const body = this.read();
    let ageMs: number;
    try {
      ageMs = this.now() - (body?.acquiredAtMs ?? statSync(this.path).mtimeMs);
    } catch {
      return false; // vanished between checks; the next attempt will simply create it
    }
    if (ageMs > this.staleMs) return true;
    return body !== undefined && body.hostname === this.host && !this.isAlive(body.pid);
  }

  /** Renaming first means only one of several racing takers wins the abandoned file. */
  private removeStale(): void {
    const tomb = `${this.path}.stale.${this.pid}.${randomBytes(4).toString("hex")}`;
    try {
      renameSync(this.path, tomb);
      unlinkSync(tomb);
    } catch {
      // Someone else already took it over.
    }
  }

  /** Only deletes the file if it is still ours, so a late release can't free someone else's lock. */
  private release(nonce: string): void {
    if (this.read()?.nonce !== nonce) return;
    try {
      unlinkSync(this.path);
    } catch {
      // Already gone.
    }
  }
}
