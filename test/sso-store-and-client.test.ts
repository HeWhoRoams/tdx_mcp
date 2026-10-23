import { mkdtempSync, existsSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import axios, { AxiosError, AxiosHeaders } from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindingOf } from "../src/auth/identity-binding.js";
import { browserProfileDir, ssoTokenPath } from "../src/auth/paths.js";
import { ConfigError, getConfig, resetConfig } from "../src/config.js";
import { getReferenceCache, resetCaches } from "../src/services/cache.js";
import { getClient, resetClient, TeamDynamixClient, TeamDynamixAuthError, TeamDynamixTransientAuthError, TeamDynamixPermissionError } from "../src/services/client.js";
import { SsoTokenStore, type StoredToken } from "../src/services/token-store.js";

const API = "https://example.teamdynamix.com/SBTDWebApi/api";
let home: string;

function env(overrides: Record<string, string | undefined> = {}) {
  for (const key of [
    "TEAMDYNAMIX_BEID",
    "TEAMDYNAMIX_WS_KEY",
    "TEAMDYNAMIX_USERNAME",
    "TEAMDYNAMIX_PASSWORD",
    "TEAMDYNAMIX_SSO_BROWSER_ADAPTER",
    "TEAMDYNAMIX_SSO_RENEW_LEAD_MS",
    "TEAMDYNAMIX_SSO_RENEW_RETRIES",
    "TRANSPORT",
    "HOST",
    "MCP_AUTH_TOKEN",
  ]) {
    delete process.env[key];
  }
  process.env.TEAMDYNAMIX_BASE_URL = "https://example.teamdynamix.com/SBTDWebApi";
  process.env.TEAMDYNAMIX_AUTH_METHOD = "sso";
  process.env.TDX_HOME = home;
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetConfig();
  resetCaches();
  resetClient();
}

function jwt(expSecondsFromNow: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow })).toString("base64url");
  return `h.${payload}.s`;
}

function saveToken(token: StoredToken) {
  const path = ssoTokenPath(bindingOf(API));
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(token));
  return path;
}

function unauthorized(): AxiosError {
  const error = new AxiosError("unauthorized");
  error.response = { status: 401, statusText: "", data: "", headers: new AxiosHeaders(), config: { headers: new AxiosHeaders() } };
  return error;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tdx-sso-test-"));
  env();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  for (const key of ["TEAMDYNAMIX_AUTH_METHOD", "TDX_HOME", "TEAMDYNAMIX_BASE_URL"]) delete process.env[key];
  resetConfig();
  resetClient();
});

describe("sso config", () => {
  it("parses sso with no other credentials", () => {
    expect(getConfig().auth.method).toBe("sso");
  });
  it("uses the local browser adapter and renewal defaults", () => {
    const auth = getConfig().auth;
    expect(auth).toMatchObject({
      method: "sso",
      renewLeadMs: 60 * 60 * 1000,
      renewRetries: 3,
    });
  });
  it("ignores admin credentials when sso is explicit", () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    env({ TEAMDYNAMIX_BEID: "b", TEAMDYNAMIX_WS_KEY: "k" });
    expect(getConfig().auth.method).toBe("sso");
    expect(write).toHaveBeenCalled();
  });
  it("warns when persistent SSO is not bound to an expected user", () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    getConfig();
    expect(write).toHaveBeenCalledWith(expect.stringContaining("TEAMDYNAMIX_SSO_EXPECTED_USER"));
  });
  it("never auto-selects sso", () => {
    env({ TEAMDYNAMIX_AUTH_METHOD: undefined });
    expect(() => getConfig()).toThrow(ConfigError);
  });
  it("refuses a remote http transport", () => {
    env({ TRANSPORT: "http", HOST: "0.0.0.0", MCP_AUTH_TOKEN: "x" });
    expect(() => getConfig()).toThrow(/local-only/);
  });
  it("rejects the removed browser-adapter variable and names its replacement", () => {
    env({ TEAMDYNAMIX_SSO_BROWSER_ADAPTER: "hermes-cdp" });
    expect(() => getConfig()).toThrow(/TEAMDYNAMIX_MCP_DEPLOYMENT/);
  });
});

describe("SsoTokenStore", () => {
  it("reloads when the file changes and purges caches when the user changes", () => {
    const store = new SsoTokenStore(ssoTokenPath(bindingOf(API)));
    expect(store.read()).toBeUndefined();
    store.write({ token: jwt(3600), expiresAtMs: Date.now() + 3_600_000, uid: "uid-1" });
    expect(store.read()?.uid).toBe("uid-1");
    getReferenceCache().set("people/lookup", "uid-1 data", 60_000);
    // another process (npm run login) replaces the file with a different user
    const other = new SsoTokenStore(ssoTokenPath(bindingOf(API)));
    other.write({ token: jwt(3600), expiresAtMs: Date.now() + 3_600_000, uid: "uid-2" });
    expect(store.read()?.uid).toBe("uid-2");
    expect(getReferenceCache().getAllowStale("people/lookup")).toBeUndefined();
  });
  it("purges caches when this process writes a token for a different user", () => {
    const store = new SsoTokenStore(ssoTokenPath(bindingOf(API)));
    store.write({ token: jwt(3600), expiresAtMs: Date.now() + 3_600_000, uid: "uid-1" });
    getReferenceCache().set("people/lookup", "uid-1 data", 60_000);

    store.write({ token: jwt(3600), expiresAtMs: Date.now() + 3_600_000, uid: "uid-2" });

    expect(getReferenceCache().getAllowStale("people/lookup")).toBeUndefined();
  });
  it("keeps separate files for sandbox and production", () => {
    expect(ssoTokenPath(bindingOf(API))).not.toBe(ssoTokenPath(bindingOf("https://example.teamdynamix.com/TDWebApi/api")));
    expect(browserProfileDir(bindingOf(API))).not.toBe(browserProfileDir(bindingOf("https://example.teamdynamix.com/TDWebApi/api")));
  });
});

describe("sso client", () => {
  function stub(requestImpl: () => Promise<unknown>, getImpl: () => Promise<unknown>) {
    vi.spyOn(axios, "create").mockReturnValue({
      request: vi.fn(requestImpl),
      get: vi.fn(getImpl),
      post: vi.fn(),
    } as unknown as ReturnType<typeof axios.create>);
    // The sign-in lifecycle probes /auth/getuser itself, with its own request.
    vi.spyOn(axios, "get").mockImplementation(getImpl as never);
  }

  it("asks for a sign-in when no token is saved, without any network call", async () => {
    stub(async () => ({ status: 200, data: {} }), async () => ({ status: 200 }));
    await expect(getClient().request("/people")).rejects.toThrow(TeamDynamixAuthError);
    await expect(getClient().request("/people")).rejects.toThrow(/npm run login/);
  });

  it("keeps the token when a 401 is really a permission denial", async () => {
    const path = saveToken({ token: jwt(7200), expiresAtMs: Date.now() + 7_200_000, uid: "u" });
    stub(async () => { throw unauthorized(); }, async () => ({ status: 200, data: {} }));
    await expect(getClient().request("/tickets/1")).rejects.toThrow(TeamDynamixPermissionError);
    expect(existsSync(path)).toBe(true);
  });

  it("drops the token when getuser also says 401", async () => {
    const path = saveToken({ token: jwt(7200), expiresAtMs: Date.now() + 7_200_000, uid: "u" });
    stub(async () => { throw unauthorized(); }, async () => { throw unauthorized(); });
    await expect(getClient().request("/tickets/1")).rejects.toThrow(/sign-in required/);
    expect(existsSync(path)).toBe(false);
  });

  it("a probe timeout after a 401 keeps the token and reports a transient failure", async () => {
    const path = saveToken({ token: jwt(7200), expiresAtMs: Date.now() + 7_200_000, uid: "u" });
    stub(async () => { throw unauthorized(); }, async () => { throw Object.assign(new Error("timeout"), { code: "ECONNABORTED" }); });
    await expect(getClient().request("/people")).rejects.toThrow(TeamDynamixTransientAuthError);
    expect(existsSync(path)).toBe(true);
  });

  it("treats an expired token as expired without probing", async () => {
    saveToken({ token: jwt(-60), expiresAtMs: Date.now() - 60_000, uid: "u" });
    stub(async () => ({ status: 200, data: {} }), async () => ({ status: 200 }));
    await expect(getClient().request("/people")).rejects.toThrow(/expired/);
  });
});

describe("cache namespace", () => {
  it("separates realms, expected users and signed-in people, and never shares an unverified identity", async () => {
    const { scopedCacheKey, setCacheNamespace } = await import("../src/services/cache.js");
    const { bindingDigest, bindingOf } = await import("../src/auth/identity-binding.js");
    expect(scopedCacheKey("k")).toBe("k"); // no provider: shared service identity
    try {
      let ns: string | undefined;
      setCacheNamespace(() => ns);
      expect(scopedCacheKey("k")).toBe("sso:unverified:k");
      const sandbox = bindingOf("https://x.teamdynamix.com/SBTDWebApi/api");
      const prod = bindingOf("https://x.teamdynamix.com/TDWebApi/api");
      expect(bindingDigest(sandbox)).not.toBe(bindingDigest(prod));
      expect(bindingDigest(bindingOf(sandbox.realm, "A@x.edu"))).toBe(bindingDigest(bindingOf(sandbox.realm + "/", "a@x.edu")));
      ns = `${bindingDigest(sandbox)}:u1`;
      const forU1 = scopedCacheKey("k");
      ns = `${bindingDigest(sandbox)}:u2`;
      const forU2 = scopedCacheKey("k");
      ns = `${bindingDigest(prod)}:u1`;
      expect(new Set([forU1, forU2, scopedCacheKey("k")]).size).toBe(3);
    } finally {
      setCacheNamespace(undefined);
    }
  });
});

describe("client with an injected SsoAuthorization", () => {
  it("sends only the handle's header, reports 401s by fingerprint, and never touches a token file", async () => {
    const request = vi.fn(async () => { throw unauthorized(); });
    vi.spyOn(axios, "create").mockReturnValue({ request, get: vi.fn(), post: vi.fn() } as unknown as ReturnType<typeof axios.create>);
    const sso = {
      authorize: vi.fn(async () => ({ header: "Bearer from-handle", fingerprint: "fp1" })),
      reportUnauthorized: vi.fn(async () => "permission-denied" as const),
      stop: vi.fn(),
    };
    const client = new TeamDynamixClient(sso);
    await expect(client.request("/tickets/1")).rejects.toThrow(TeamDynamixPermissionError);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ headers: { Authorization: "Bearer from-handle" } }));
    expect(sso.reportUnauthorized).toHaveBeenCalledWith("fp1");
    client.destroy();
    expect(sso.stop).toHaveBeenCalled();
  });

  it("maps handle failures to the single canonical codes", async () => {
    vi.spyOn(axios, "create").mockReturnValue({ request: vi.fn(), get: vi.fn(), post: vi.fn() } as unknown as ReturnType<typeof axios.create>);
    const { SsoActionRequiredError, SsoUnavailableError } = await import("../src/auth/sso-errors.js");
    const make = (error: Error) =>
      new TeamDynamixClient({ authorize: async () => { throw error; }, reportUnauthorized: vi.fn(), stop: vi.fn() } as never);
    await expect(make(new SsoActionRequiredError("go sign in")).request("/x")).rejects.toThrow(/^SSO_ACTION_REQUIRED: go sign in/);
    await expect(make(new SsoUnavailableError("later")).request("/x")).rejects.toThrow(/^SSO_RENEWAL_UNAVAILABLE: later/);
  });
});
