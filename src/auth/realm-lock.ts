import { randomBytes } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { hostname as osHostname } from "node:os";
import { dirname } from "node:path";

export interface RealmLockOptions {
  /** A lock whose timestamp is older than this is considered abandoned (holders refresh it, see `refresh`). */
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

export interface LockHandle {
  /** Frees the lock, but only if it is still ours. */
  release(): void;
  /** Proves the holder is alive so a long critical section is not taken over. */
  refresh(): void;
}

export const DEFAULT_LOCK_STALE_MS = 2 * 60_000;
/** How long a taker may hold the takeover mutex; one that old was abandoned by a crash. */
const TAKEOVER_STALE_MS = 10_000;

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Blocks the thread without spinning. Only the state lock's tiny critical sections wait this way;
 * a crashed holder on this machine is detected immediately, so waits are short in practice.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Cross-process mutual exclusion for one realm, built on an exclusive-create lock file.
 * An abandoned lock (holder gone on this host, or timestamp older than `staleMs`) is taken over
 * under a second short-lived mutex that re-checks staleness, so a fresh lock is never removed.
 */
export class RealmLock {
  readonly staleMs: number;
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

  /** Takes the lock if it is free (or abandoned). Returns a handle, or undefined when busy. */
  tryAcquire(): LockHandle | undefined {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const created = this.create(this.path);
    if (created) return this.handle(created);

    const observed = this.read(this.path);
    if (!this.isStale(this.path, observed)) return undefined;

    const takeoverPath = `${this.path}.takeover`;
    const mutex = this.create(takeoverPath);
    if (!mutex) {
      // Someone else is taking over. If their mutex is itself abandoned, clear it for next time.
      if (this.isOlderThan(takeoverPath, TAKEOVER_STALE_MS)) this.discard(takeoverPath);
      return undefined;
    }
    try {
      const current = this.read(this.path);
      // Re-check under the mutex: the lock may have been released, or replaced by a live holder.
      if (current?.nonce !== observed?.nonce || !this.isStale(this.path, current)) return undefined;
      this.discard(this.path);
      const taken = this.create(this.path);
      return taken ? this.handle(taken) : undefined;
    } finally {
      this.removeIfOurs(takeoverPath, mutex);
    }
  }

  /** Runs `fn` while holding the lock, waiting up to `waitMs` for it. Throws if it cannot be taken. */
  withSync<T>(fn: () => T, { waitMs = 2_000, pollMs = 50 }: { waitMs?: number; pollMs?: number } = {}): T {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const handle = this.tryAcquire();
      if (handle) {
        try {
          return fn();
        } finally {
          handle.release();
        }
      }
      if (Date.now() >= deadline) throw new Error("Timed out waiting for the TeamDynamix sign-in state lock.");
      sleepSync(pollMs);
    }
  }

  private create(path: string): string | undefined {
    const nonce = randomBytes(8).toString("hex");
    const body: LockBody = { pid: this.pid, hostname: this.host, acquiredAtMs: this.now(), nonce };
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeSync(fd, JSON.stringify(body));
      } finally {
        closeSync(fd);
      }
      return nonce;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return undefined;
    }
  }

  private handle(nonce: string): LockHandle {
    return {
      release: () => this.removeIfOurs(this.path, nonce),
      refresh: () => {
        if (this.read(this.path)?.nonce !== nonce) return;
        const body: LockBody = { pid: this.pid, hostname: this.host, acquiredAtMs: this.now(), nonce };
        const tmp = `${this.path}.${this.pid}.${randomBytes(3).toString("hex")}.tmp`;
        try {
          writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
          renameSync(tmp, this.path);
        } catch {
          // A missed heartbeat is tolerable; the next one (or the stale window) covers it.
        }
      },
    };
  }

  private read(path: string): LockBody | undefined {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as LockBody;
    } catch {
      return undefined;
    }
  }

  private isOlderThan(path: string, ms: number): boolean {
    try {
      return this.now() - statSync(path).mtimeMs > ms;
    } catch {
      return false;
    }
  }

  private isStale(path: string, body: LockBody | undefined): boolean {
    let ageMs: number;
    try {
      ageMs = this.now() - (body?.acquiredAtMs ?? statSync(path).mtimeMs);
    } catch {
      return false; // vanished between checks; the caller will simply try again
    }
    if (ageMs > this.staleMs) return true;
    return body !== undefined && body.hostname === this.host && !this.isAlive(body.pid);
  }

  private discard(path: string): void {
    try {
      unlinkSync(path);
    } catch {
      // Already gone.
    }
  }

  /** Only deletes the file if it is still ours, so a late release can't free someone else's lock. */
  private removeIfOurs(path: string, nonce: string): void {
    if (this.read(path)?.nonce === nonce) this.discard(path);
  }
}
