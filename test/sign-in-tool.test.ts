import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfig } from "../src/config.js";
import { resetInteractiveLogin, runInteractiveLogin } from "../src/auth/interactive-login.js";
import { signInAction } from "../src/auth/sso-errors.js";
import { getConfig, isSsoConfig } from "../src/config.js";
import { runWithRequestContext } from "../src/services/request-context.js";
import { SsoLifecycle } from "../src/auth/sso-lifecycle.js";
import { authTools } from "../src/tools/auth.js";

const tool = authTools.find((t) => t.name === "tdx_sign_in")!;

function ssoEnv(deployment: "local" | "external" = "local"): void {
  for (const key of ["TEAMDYNAMIX_BEID", "TEAMDYNAMIX_WS_KEY", "TEAMDYNAMIX_USERNAME", "TEAMDYNAMIX_PASSWORD"]) delete process.env[key];
  process.env.TEAMDYNAMIX_BASE_URL = "https://example.teamdynamix.com";
  process.env.TEAMDYNAMIX_AUTH_METHOD = "sso";
  process.env.TEAMDYNAMIX_MCP_DEPLOYMENT = deployment;
  if (deployment === "external") process.env.TEAMDYNAMIX_SSO_CDP_ENDPOINT = "http://127.0.0.1:9222";
  resetConfig();
  resetInteractiveLogin();
}

const stored = { token: "SECRET.TOKEN.VALUE", expiresAtMs: Date.now() + 3_600_000, fullName: "Ada Lovelace", email: "ada@example.edu", uid: "u-1" };

afterEach(() => {
  delete process.env.TEAMDYNAMIX_AUTH_METHOD;
  delete process.env.TEAMDYNAMIX_MCP_DEPLOYMENT;
  delete process.env.TEAMDYNAMIX_SSO_CDP_ENDPOINT;
  resetConfig();
  resetInteractiveLogin();
  vi.restoreAllMocks();
});

describe("runInteractiveLogin", () => {
  beforeEach(() => ssoEnv());

  it("is single-flight: a second call waits for the first window", async () => {
    const config = getConfig();
    if (!isSsoConfig(config)) throw new Error("expected sso");
    let finish!: (value: typeof stored) => void;
    const login = vi.fn(() => new Promise<never>((resolve) => (finish = resolve as never)));
    const first = runInteractiveLogin(config, { lifecycle: { login } });
    const second = runInteractiveLogin(config, { lifecycle: { login } });
    expect(login).toHaveBeenCalledTimes(1);
    finish(stored);
    expect(await first).toBe(await second);
    // After it settles a new sign-in may start.
    login.mockResolvedValueOnce(stored as never);
    await runInteractiveLogin(config, { lifecycle: { login } });
    expect(login).toHaveBeenCalledTimes(2);
  });

  it("passes the abort signal to the lifecycle", async () => {
    const config = getConfig();
    if (!isSsoConfig(config)) throw new Error("expected sso");
    const login = vi.fn(async (_signal?: AbortSignal) => stored as never);
    const controller = new AbortController();
    await runInteractiveLogin(config, { lifecycle: { login }, signal: controller.signal });
    expect(login).toHaveBeenCalledWith(controller.signal);
  });
});

describe("tdx_sign_in", () => {
  it("returns who signed in and never the token", async () => {
    ssoEnv();
    vi.spyOn(SsoLifecycle.prototype, "login").mockResolvedValue(stored as never);
    const result = await runWithRequestContext({}, () => tool.handler({ response_format: "markdown" }));
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(result).toMatchObject({ name: "Ada Lovelace", uid: "u-1", email: "ada@example.edu" });
    expect(tool.render(result, {})).toContain("Ada Lovelace");
  });

  it("refuses when the server does not sign users in locally", async () => {
    delete process.env.TEAMDYNAMIX_AUTH_METHOD;
    process.env.TEAMDYNAMIX_BEID = "b";
    process.env.TEAMDYNAMIX_WS_KEY = "k";
    resetConfig();
    await expect(tool.handler({ response_format: "markdown" })).rejects.toThrow(/locally run server/);
  });

  it("is declared as requiring local SSO", () => {
    expect(tool.requiresAuth).toEqual({ method: "sso", deployment: "local" });
  });
});

describe("signInAction", () => {
  it("names the tool first for a local deployment and the command alone otherwise", () => {
    ssoEnv("local");
    expect(signInAction()).toMatch(/^Call tdx_sign_in/);
    expect(signInAction()).toContain("npm run login");
    ssoEnv("external");
    expect(signInAction()).toBe("Run `npm run login` in the server folder");
  });
});
