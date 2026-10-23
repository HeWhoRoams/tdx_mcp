import { describe, expect, it, vi } from "vitest";
import { CredentialState, MemoryStatePersistence } from "../src/auth/credential-state.js";
import type { SsoBrowserSession } from "../src/auth/sso-browser.js";
import { SsoActionRequiredError, SsoUnavailableError } from "../src/auth/sso-errors.js";
import { SsoLoginError, SsoPolicyError } from "../src/auth/sso-login.js";
import { backoffDelayMs, RENEWAL_SAFETY_MS, SsoRenewalManager } from "../src/auth/sso-renewal.js";
import type { StoredToken, TokenStore } from "../src/services/token-store.js";

const oldToken: StoredToken = { token: "old", expiresAtMs: 10_000, uid: "u" };
const newToken: StoredToken = { token: "new", expiresAtMs: 20_000, uid: "u" };
/** More than the safety margin left, so renewal happens behind the call instead of in front of it. */
const longToken: StoredToken = { token: "long", expiresAtMs: 400_000, uid: "u" };

function session(token = "minted"): SsoBrowserSession {
  return { mintToken: vi.fn(async () => token), close: vi.fn(async () => undefined) };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function harness(
  initial: StoredToken | undefined,
  options: {
    nowMs?: number;
    leadMs?: number;
    retries?: number;
    openSession?: () => Promise<SsoBrowserSession>;
    validateToken?: (token: string, previous?: StoredToken) => Promise<StoredToken>;
  } = {}
) {
  let current = initial;
  const writes: StoredToken[] = [];
  const tokens: TokenStore = {
    read: () => current,
    write: (token) => {
      current = token;
      writes.push(token);
    },
    clear: () => {
      current = undefined;
    },
  };
  const clock = { nowMs: options.nowMs ?? 6_000 };
  const state = new CredentialState(tokens, new MemoryStatePersistence(), () => clock.nowMs);
  const audit = vi.fn();
  const sleep = vi.fn(async () => undefined);
  const openSession = vi.fn(options.openSession ?? (async () => session()));
  const validateToken = vi.fn(options.validateToken ?? (async () => newToken));
  const manager = new SsoRenewalManager({
    state,
    leadMs: options.leadMs ?? 5_000,
    retries: options.retries ?? 0,
    now: () => clock.nowMs,
    sleep,
    random: () => 0.5,
    openSession,
    validateToken,
    audit,
  });
  return { manager, state, writes, clock, audit, sleep, openSession, validateToken, read: () => current };
}

const mfa = async (): Promise<SsoBrowserSession> => {
  throw new SsoPolicyError("MFA is required");
};
const unavailable = async (): Promise<SsoBrowserSession> => {
  throw new Error("browser unavailable");
};

describe("SsoRenewalManager", () => {
  it("validates and atomically replaces an expiring token", async () => {
    const browser = session();
    const h = harness(oldToken, { openSession: async () => browser });

    await expect(h.manager.getUsableToken()).resolves.toBe("new");
    expect(h.writes).toEqual([newToken]);
    expect(browser.close).toHaveBeenCalledOnce();
    expect(h.audit).toHaveBeenCalledWith("renewal_succeeded", { uid: "u", expiresAtMs: 20_000 });
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain("minted");
  });

  it("shares one renewal when concurrent callers need a token", async () => {
    const h = harness(undefined);
    await expect(Promise.all([h.manager.getUsableToken(), h.manager.getUsableToken()])).resolves.toEqual(["new", "new"]);
    expect(h.openSession).toHaveBeenCalledOnce();
  });

  it("does not retry an interactive SSO policy failure", async () => {
    const h = harness(undefined, { retries: 3, openSession: mfa });
    await expect(h.manager.getUsableToken()).rejects.toThrow(/MFA is required|sign-in required/);
    expect(h.openSession).toHaveBeenCalledOnce();
  });

  describe("a failed renewal never makes a still-valid token unusable", () => {
    it("policy failure in the lead window: serves the old token, blocks renewal, never relaunches", async () => {
      const h = harness(longToken, { nowMs: 100_000, leadMs: 350_000, retries: 3, openSession: mfa });

      await expect(h.manager.getUsableToken()).resolves.toBe("long"); // served at once; renewal runs behind it
      await vi.waitFor(() => expect(h.state.status().kind).toBe("renewal-blocked"));
      expect(h.openSession).toHaveBeenCalledOnce();

      await expect(h.manager.getUsableToken()).resolves.toBe("long"); // still served
      await settle();
      expect(h.openSession).toHaveBeenCalledOnce(); // no second browser launch

      h.clock.nowMs = 500_000; // after expiry nothing is left to serve
      await expect(h.manager.getUsableToken()).rejects.toThrow(SsoActionRequiredError);
      await expect(h.manager.getUsableToken()).rejects.toThrow(/sign-in required/i);
    });

    it("policy failure when the token is nearly expired but valid: still served", async () => {
      const h = harness(oldToken, { nowMs: 6_000, openSession: mfa }); // 4s left: renewal is in front of the call
      await expect(h.manager.getUsableToken()).resolves.toBe("old");
      expect(h.state.status()).toMatchObject({ kind: "renewal-blocked", reason: "interaction-required" });
    });

    it("a different user on renewal is rejected: old token kept, renewal blocked, nothing written", async () => {
      const h = harness(oldToken, {
        validateToken: async () => {
          throw new SsoLoginError("different user", "identity-mismatch");
        },
      });
      await expect(h.manager.getUsableToken()).resolves.toBe("old");
      expect(h.state.status()).toMatchObject({ kind: "renewal-blocked", reason: "identity-mismatch" });
      expect(h.writes).toEqual([]);
    });
  });

  describe("transient failures", () => {
    it("retry with backoff, never block, and do not relaunch inside the delay", async () => {
      const h = harness(longToken, { nowMs: 100_000, leadMs: 350_000, retries: 1, openSession: unavailable });

      await expect(h.manager.getUsableToken()).resolves.toBe("long");
      await vi.waitFor(() => expect(h.openSession).toHaveBeenCalledTimes(2)); // one try plus one retry
      await settle();
      expect(h.sleep).toHaveBeenCalledWith(2_000); // in-call backoff, jitter factor 1.0
      expect(h.state.status().kind).toBe("usable"); // transient failures never block

      await h.manager.getUsableToken(); // inside the retry delay
      await settle();
      expect(h.openSession).toHaveBeenCalledTimes(2);

      h.clock.nowMs += 31_000; // past the 30s retry delay, token still has plenty of life
      await h.manager.getUsableToken();
      await vi.waitFor(() => expect(h.openSession).toHaveBeenCalledTimes(4));
      expect(h.state.status().kind).toBe("usable");
    });

    it("with no valid token left: unavailable, but nothing is blocked", async () => {
      const h = harness(oldToken, { nowMs: 50_000, openSession: unavailable }); // expired
      await expect(h.manager.getUsableToken()).rejects.toThrow(SsoUnavailableError);
      expect(h.state.status().kind).toBe("needs-renewal");
    });
  });

  describe("backoff applies to foreground callers too", () => {
    it("does not relaunch a browser on every call while waiting to retry", async () => {
      const h = harness(oldToken, { nowMs: 50_000, openSession: unavailable }); // expired
      await expect(h.manager.getUsableToken()).rejects.toThrow(SsoUnavailableError);
      expect(h.openSession).toHaveBeenCalledTimes(1);
      await expect(h.manager.getUsableToken()).rejects.toThrow(/waiting to retry/);
      await expect(h.manager.getUsableToken()).rejects.toThrow(/waiting to retry/);
      expect(h.openSession).toHaveBeenCalledTimes(1);
      h.clock.nowMs += 60_000; // past the retry delay
      await expect(h.manager.getUsableToken()).rejects.toThrow(SsoUnavailableError);
      expect(h.openSession).toHaveBeenCalledTimes(2);
    });
  });

  describe("logout wins over a renewal that is already running", () => {
    it("discards the renewed token instead of signing the user back in", async () => {
      let release!: (token: string) => void;
      const minted = new Promise<string>((resolve) => (release = resolve));
      const mintStarted = vi.fn();
      const h = harness(oldToken, {
        nowMs: 50_000, // expired, so the call waits on the renewal
        openSession: async () => ({
          mintToken: () => {
            mintStarted();
            return minted;
          },
          close: async () => undefined,
        }),
        validateToken: async () => ({ ...newToken, expiresAtMs: 900_000 }),
      });

      const pending = h.manager.getUsableToken();
      await vi.waitFor(() => expect(mintStarted).toHaveBeenCalled());
      h.state.signOut(); // the user runs `npm run logout` while the browser is mid-renewal
      release("minted");

      await expect(pending).rejects.toThrow(/sign-in required/i);
      expect(h.read()).toBeUndefined(); // the renewed token was never written
      expect(h.writes).toEqual([]);
      expect(h.state.status()).toMatchObject({ kind: "action-required", reason: "signed-out" });
      expect(h.audit).toHaveBeenCalledWith("renewal_discarded");
    });

    it("never mints silently after an explicit logout", async () => {
      const h = harness(undefined);
      h.state.signOut();
      await expect(h.manager.getUsableToken()).rejects.toThrow(/sign-in required/i);
      expect(h.openSession).not.toHaveBeenCalled();
    });
  });
});

describe("backoffDelayMs", () => {
  it("doubles from the base and caps", () => {
    expect(backoffDelayMs(0, 2_000, 15_000, () => 0.5)).toBe(2_000);
    expect(backoffDelayMs(1, 2_000, 15_000, () => 0.5)).toBe(4_000);
    expect(backoffDelayMs(2, 2_000, 15_000, () => 0.5)).toBe(8_000);
    expect(backoffDelayMs(3, 2_000, 15_000, () => 0.5)).toBe(15_000);
    expect(backoffDelayMs(10, 2_000, 15_000, () => 1)).toBe(15_000);
  });
  it("jitters by plus or minus 20 percent", () => {
    expect(backoffDelayMs(0, 10_000, 100_000, () => 0)).toBe(8_000);
    expect(backoffDelayMs(0, 10_000, 100_000, () => 1)).toBe(12_000);
  });
  it("exposes a safety margin shorter than the default renewal lead", () => {
    expect(RENEWAL_SAFETY_MS).toBeLessThan(60 * 60_000);
  });
});
