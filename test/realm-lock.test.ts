import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialState, MemoryStatePersistence } from "../src/auth/credential-state.js";
import { RealmLock } from "../src/auth/realm-lock.js";
import type { SsoBrowserSession } from "../src/auth/sso-browser.js";
import { SsoRenewalManager } from "../src/auth/sso-renewal.js";
import type { StoredToken, TokenStore } from "../src/services/token-store.js";

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tdx-lock-"));
  path = join(dir, "sso.lock");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("RealmLock", () => {
  it("excludes a second holder until released", () => {
    const a = new RealmLock(path);
    const b = new RealmLock(path);
    const release = a.tryAcquire();
    expect(release).toBeDefined();
    expect(b.tryAcquire()).toBeUndefined();
    release!();
    expect(existsSync(path)).toBe(false);
    expect(b.tryAcquire()).toBeDefined();
  });

  it("takes over a lock whose process is gone", () => {
    writeFileSync(path, JSON.stringify({ pid: 999_999, hostname: "h", acquiredAtMs: Date.now(), nonce: "x" }));
    const lock = new RealmLock(path, { hostname: "h", isAlive: () => false });
    expect(lock.tryAcquire()).toBeDefined();
  });

  it("does not take over a live holder on the same host", () => {
    writeFileSync(path, JSON.stringify({ pid: 1, hostname: "h", acquiredAtMs: Date.now(), nonce: "x" }));
    expect(new RealmLock(path, { hostname: "h", isAlive: () => true }).tryAcquire()).toBeUndefined();
  });

  it("does not trust pid liveness for another host, but takes over an old lock", () => {
    const old = Date.now() - 10 * 60_000;
    writeFileSync(path, JSON.stringify({ pid: 1, hostname: "other", acquiredAtMs: Date.now(), nonce: "x" }));
    expect(new RealmLock(path, { hostname: "h", isAlive: () => false }).tryAcquire()).toBeUndefined();
    writeFileSync(path, JSON.stringify({ pid: 1, hostname: "other", acquiredAtMs: old, nonce: "x" }));
    expect(new RealmLock(path, { hostname: "h", staleMs: 60_000 }).tryAcquire()).toBeDefined();
  });

  it("releases when the critical section throws, and a late release cannot free someone else's lock", () => {
    const lock = new RealmLock(path);
    expect(() => lock.withSync(() => { throw new Error("boom"); })).toThrow("boom");
    expect(existsSync(path)).toBe(false);

    const stale = lock.tryAcquire()!;
    rmSync(path);
    const other = new RealmLock(path).tryAcquire()!;
    stale(); // not ours any more
    expect(existsSync(path)).toBe(true);
    other();
  });

  it("withSync times out when the lock stays busy", () => {
    const held = new RealmLock(path).tryAcquire()!;
    expect(() => new RealmLock(path).withSync(() => 1, { waitMs: 120, pollMs: 20 })).toThrow(/Timed out/);
    held();
  });
});

describe("two renewal managers in one realm", () => {
  const initial: StoredToken = { token: "old", expiresAtMs: 10_000, uid: "u" };
  const fresh: StoredToken = { token: "fresh", expiresAtMs: 5_000_000, uid: "u" };

  function pair() {
    let current: StoredToken | undefined = initial;
    const store: TokenStore = { read: () => current, write: (t) => void (current = t), clear: () => void (current = undefined) };
    const persistence = new MemoryStatePersistence(); // shared like the state file would be
    const clock = { now: 50_000 };
    const open = vi.fn(async (): Promise<SsoBrowserSession> => {
      await new Promise((r) => setTimeout(r, 30));
      return { mintToken: async () => "minted", close: async () => undefined };
    });
    const make = () =>
      new SsoRenewalManager({
        state: new CredentialState(store, persistence, () => clock.now),
        renewalLock: new RealmLock(path),
        leadMs: 5_000,
        retries: 0,
        now: () => clock.now,
        sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
        openSession: open,
        validateToken: async () => fresh,
      });
    return { a: make(), b: make(), open, read: () => current };
  }

  it("launch the browser once and both resolve to the same token", async () => {
    const { a, b, open } = pair();
    await expect(Promise.all([a.getUsableToken(), b.getUsableToken()])).resolves.toEqual(["fresh", "fresh"]);
    expect(open).toHaveBeenCalledOnce();
    expect(existsSync(path)).toBe(false);
  });

  it("waiting too long for a peer is transient, not a block", async () => {
    const { a, read } = pair();
    const held = new RealmLock(path).tryAcquire()!; // a peer that never finishes
    const manager = new SsoRenewalManager({
      state: (a as unknown as { dependencies: { state: CredentialState } }).dependencies.state,
      renewalLock: new RealmLock(path),
      peerWaitMs: 20,
      leadMs: 5_000,
      retries: 0,
      now: () => 50_000,
      sleep: async () => undefined,
      openSession: vi.fn(),
      validateToken: vi.fn(),
    });
    await expect(manager.getUsableToken()).rejects.toThrow(/unavailable|try again/i);
    expect(read()?.token).toBe("old");
    held();
  });
});
