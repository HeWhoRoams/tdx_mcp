import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import axios from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindingOf } from "../src/auth/identity-binding.js";
import { ssoTokenPath } from "../src/auth/paths.js";
import type { SsoBrowserSession } from "../src/auth/sso-browser.js";
import { createSsoLifecycle, type SsoProbe } from "../src/auth/sso-lifecycle.js";
import { getConfig, resetConfig } from "../src/config.js";
import { resetCaches } from "../src/services/cache.js";
import { SsoTokenStore, type StoredToken } from "../src/services/token-store.js";

let home: string;

function jwt(expSecondsFromNow: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow })).toString("base64url");
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
}

const stored = (token: string, secondsLeft: number, uid = "u1"): StoredToken => ({
  token,
  expiresAtMs: Date.now() + secondsLeft * 1000,
  uid,
});

function setup(overrides: { probe?: SsoProbe; openRenewalSession?: () => Promise<SsoBrowserSession> } = {}) {
  process.env.TEAMDYNAMIX_BASE_URL = "https://example.teamdynamix.com/SBTDWebApi";
  process.env.TEAMDYNAMIX_AUTH_METHOD = "sso";
  process.env.TDX_HOME = home;
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  resetConfig();
  resetCaches();
  const config = getConfig();
  const store = new SsoTokenStore(ssoTokenPath(bindingOf(config.apiBaseUrl)));
  const audit = vi.fn();
  const lifecycle = createSsoLifecycle(config, store, audit, { sleep: async () => undefined, ...overrides });
  return { lifecycle, store, audit };
}

function mockGetUser(uid: string) {
  return vi.spyOn(axios, "get").mockResolvedValue({ data: { UID: uid, FullName: `User ${uid}`, PrimaryEmail: `${uid}@x.edu` } });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tdx-lifecycle-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  for (const key of ["TEAMDYNAMIX_BASE_URL", "TEAMDYNAMIX_AUTH_METHOD", "TDX_HOME"]) delete process.env[key];
  resetConfig();
});

describe("handleUnauthorized", () => {
  it("probe ok: a permission denial; the token and renewal are untouched; success is cached per token", async () => {
    const probe = vi.fn<SsoProbe>(async () => "ok");
    const { lifecycle, store } = setup({ probe });
    const a = stored(jwt(7200), 7200);
    store.write(a);

    await expect(lifecycle.handleUnauthorized(a.token)).resolves.toBe("permission-denied");
    await expect(lifecycle.handleUnauthorized(a.token)).resolves.toBe("permission-denied");
    expect(probe).toHaveBeenCalledTimes(1); // second answer came from the cache

    await expect(lifecycle.handleUnauthorized(jwt(7200) + "x")).resolves.toBe("permission-denied");
    expect(probe).toHaveBeenCalledTimes(2); // a different token is probed again

    expect(store.read()?.token).toBe(a.token);
    expect(lifecycle.status().state).toBe("usable");
  });

  it("probe unauthorized: revoked; the token is deleted and renewal blocked", async () => {
    const { lifecycle, store, audit } = setup({ probe: async () => "unauthorized" });
    const a = stored(jwt(7200), 7200);
    store.write(a);

    await expect(lifecycle.handleUnauthorized(a.token)).resolves.toBe("revoked");
    expect(store.read()).toBeUndefined();
    expect(lifecycle.status()).toMatchObject({ state: "action-required", blockedReason: "invalid-token" });
    expect(audit).toHaveBeenCalledWith("token_revoked");
  });

  it.each(["unknown"] as const)("probe %s (timeout, 429, 5xx): keeps the token and blocks nothing", async (answer) => {
    const { lifecycle, store } = setup({ probe: async () => answer });
    const a = stored(jwt(7200), 7200);
    store.write(a);

    await expect(lifecycle.handleUnauthorized(a.token)).resolves.toBe("unknown");
    expect(store.read()?.token).toBe(a.token);
    expect(lifecycle.status().state).toBe("usable");
  });

  it("an expired token is just expired: no probe, no block, renewal stays allowed", async () => {
    const probe = vi.fn<SsoProbe>(async () => "ok");
    const { lifecycle, store } = setup({ probe });
    const a = stored(jwt(-60), -60);
    store.write(a);

    await expect(lifecycle.handleUnauthorized(a.token)).resolves.toBe("expired");
    expect(probe).not.toHaveBeenCalled();
    expect(lifecycle.status().state).toBe("needs-renewal");
  });

  it("does not delete a newer token written while the old token's request was failing", async () => {
    const { lifecycle, store } = setup({ probe: async () => "unauthorized" });
    const older = stored(jwt(7200), 7200);
    store.write(older);
    // another process (or a renewal) replaces the token while the old request is in flight
    const path = ssoTokenPath(bindingOf(getConfig().apiBaseUrl));
    new SsoTokenStore(path).write(stored(jwt(7200) + "new", 7200));
    const later = new Date(Date.now() + 5_000); // make the change visible to the mtime check on any filesystem
    utimesSync(path, later, later);

    await lifecycle.handleUnauthorized(older.token);

    expect(store.read()?.token).toMatch(/new$/); // the newer token survived
    expect(store.read()?.token).not.toBe(older.token);
    expect(lifecycle.status().state).toBe("usable");
  });
});

describe("identity", () => {
  it("renewal cannot switch users: the old token is kept and renewal is blocked", async () => {
    const minted = jwt(7200);
    const { lifecycle, store } = setup({
      openRenewalSession: async () => ({ mintToken: async () => minted, close: async () => undefined }),
    });
    const a = stored(jwt(30), 30, "u1"); // 30s left: renewal runs in front of the call
    store.write(a);
    mockGetUser("u2"); // the browser profile is now signed in as someone else

    await expect(lifecycle.authorization()).resolves.toBe(a.token); // still valid, so still served
    expect(store.read()?.uid).toBe("u1");
    expect(lifecycle.status()).toMatchObject({ state: "renewal-blocked", blockedReason: "identity-mismatch" });
  });

  it("an interactive login may switch users, records it, and re-enables renewal", async () => {
    const { lifecycle, store, audit } = setup({
      openRenewalSession: async () => ({ mintToken: async () => jwt(7200), close: async () => undefined }),
    });
    store.write(stored(jwt(30), 30, "u1"));
    mockGetUser("u2");
    await lifecycle.authorization(); // blocks renewal (identity mismatch)
    expect(lifecycle.status().state).toBe("renewal-blocked");

    await lifecycle.accept(jwt(7200), "paste"); // deliberate login as u2

    expect(store.read()?.uid).toBe("u2");
    expect(lifecycle.status().state).toBe("usable");
    expect(audit).toHaveBeenCalledWith("identity_changed", { fromUid: "u1", toUid: "u2" });
  });
});
