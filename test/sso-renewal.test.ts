import { describe, expect, it, vi } from "vitest";
import { SsoRenewalManager } from "../src/auth/sso-renewal.js";
import type { SsoBrowserSession } from "../src/auth/sso-browser.js";
import { SsoPolicyError } from "../src/auth/sso-login.js";
import type { StoredToken, TokenStore } from "../src/services/token-store.js";

const oldToken: StoredToken = { token: "old", expiresAtMs: 10_000, uid: "u" };
const newToken: StoredToken = { token: "new", expiresAtMs: 20_000, uid: "u" };

function store(initial: StoredToken | undefined): TokenStore & { writes: StoredToken[] } {
  let current = initial;
  const writes: StoredToken[] = [];
  return {
    writes,
    read: () => current,
    write: (token) => {
      current = token;
      writes.push(token);
    },
    clear: () => {
      current = undefined;
    },
  };
}

function lifecycleStore(initial: StoredToken | undefined) {
  const tokens = store(initial);
  let automaticRenewalAllowed = true;
  return {
    ...tokens,
    isAutomaticRenewalAllowed: () => automaticRenewalAllowed,
    blockAutomaticRenewal: () => {
      automaticRenewalAllowed = false;
    },
  };
}

function session(token = "minted"): SsoBrowserSession {
  return { mintToken: vi.fn(async () => token), close: vi.fn(async () => undefined) };
}

describe("SsoRenewalManager", () => {
  it("validates and atomically replaces an expiring token", async () => {
    const tokens = store(oldToken);
    const browser = session();
    const audit = vi.fn();
    const manager = new SsoRenewalManager({
      store: tokens,
      leadMs: 5_000,
      retries: 0,
      now: () => 6_000,
      openSession: vi.fn(async () => browser),
      validateToken: vi.fn(async () => newToken),
      audit,
    });

    await expect(manager.getUsableToken()).resolves.toBe("new");
    expect(tokens.writes).toEqual([newToken]);
    expect(browser.close).toHaveBeenCalledOnce();
    expect(audit).toHaveBeenCalledWith("renewal_succeeded", { uid: "u", expiresAtMs: 20_000 });
    expect(JSON.stringify(audit.mock.calls)).not.toContain("minted");
  });

  it("shares one renewal when concurrent callers need a token", async () => {
    const tokens = store(undefined);
    const browser = session();
    const openSession = vi.fn(async () => browser);
    const manager = new SsoRenewalManager({
      store: tokens,
      leadMs: 5_000,
      retries: 0,
      now: () => 6_000,
      openSession,
      validateToken: vi.fn(async () => newToken),
    });

    await expect(Promise.all([manager.getUsableToken(), manager.getUsableToken()])).resolves.toEqual(["new", "new"]);
    expect(openSession).toHaveBeenCalledOnce();
  });

  it("keeps a still-valid token when proactive renewal fails", async () => {
    const tokens = store(oldToken);
    const manager = new SsoRenewalManager({
      store: tokens,
      leadMs: 5_000,
      retries: 0,
      now: () => 6_000,
      openSession: vi.fn(async () => {
        throw new Error("browser unavailable");
      }),
      validateToken: vi.fn(),
    });

    await expect(manager.getUsableToken()).resolves.toBe("old");
    expect(tokens.writes).toEqual([]);
  });

  it("does not retry an interactive SSO policy failure", async () => {
    const openSession = vi.fn(async () => {
      throw new SsoPolicyError("MFA is required");
    });
    const manager = new SsoRenewalManager({
      store: store(undefined),
      leadMs: 5_000,
      retries: 3,
      now: () => 6_000,
      openSession,
      validateToken: vi.fn(),
    });

    await expect(manager.getUsableToken()).rejects.toThrow(/MFA is required/);
    expect(openSession).toHaveBeenCalledOnce();
  });

  it("records a policy interruption and never opens the browser again until login clears it", async () => {
    const tokens = lifecycleStore(oldToken);
    const openSession = vi.fn(async () => {
      throw new SsoPolicyError("MFA is required");
    });
    const manager = new SsoRenewalManager({
      store: tokens,
      leadMs: 5_000,
      retries: 3,
      now: () => 6_000,
      openSession,
      validateToken: vi.fn(),
    });

    await expect(manager.getUsableToken()).rejects.toThrow(/MFA is required/);
    await expect(manager.getUsableToken()).rejects.toThrow(/sign-in required/i);
    expect(openSession).toHaveBeenCalledOnce();
  });

  it("does not silently mint a token after an explicit logout", async () => {
    const tokens = lifecycleStore(undefined);
    tokens.blockAutomaticRenewal();
    const openSession = vi.fn(async () => session());
    const manager = new SsoRenewalManager({
      store: tokens,
      leadMs: 5_000,
      retries: 0,
      now: () => 6_000,
      openSession,
      validateToken: vi.fn(async () => newToken),
    });

    await expect(manager.getUsableToken()).rejects.toThrow(/sign-in required/i);
    expect(openSession).not.toHaveBeenCalled();
  });
});
