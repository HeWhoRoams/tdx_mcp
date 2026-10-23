import { beforeEach, describe, expect, it } from "vitest";
import { ConfigError, getConfig, resetConfig, resolveApiBaseUrl } from "../src/config.js";

const REQUIRED = {
  TEAMDYNAMIX_BASE_URL: "https://example.teamdynamix.com",
  TEAMDYNAMIX_BEID: "beid-1",
  TEAMDYNAMIX_WS_KEY: "key-1",
};

function withEnv(overrides: Record<string, string | undefined>): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("TEAMDYNAMIX_") || key.startsWith("MCP_") || ["TRANSPORT", "HOST", "PORT", "TDX_LOG_LEVEL"].includes(key)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetConfig();
}

describe("resolveApiBaseUrl", () => {
  it.each([
    ["https://example.teamdynamix.com", "https://example.teamdynamix.com/TDWebApi/api"],
    ["https://example.teamdynamix.com/", "https://example.teamdynamix.com/TDWebApi/api"],
    ["https://example.teamdynamix.com/TDWebApi", "https://example.teamdynamix.com/TDWebApi/api"],
    ["https://sandbox.teamdynamix.com/SBTDWebApi", "https://sandbox.teamdynamix.com/SBTDWebApi/api"],
    ["https://sandbox.teamdynamix.com/SBTDWebApi/api", "https://sandbox.teamdynamix.com/SBTDWebApi/api"],
  ])("normalizes %s", (input, expected) => {
    expect(resolveApiBaseUrl(input)).toBe(expected);
  });
});

describe("getConfig", () => {
  beforeEach(() => withEnv(REQUIRED));

  it("prefers admin auth when both credential sets are present", () => {
    withEnv({ ...REQUIRED, TEAMDYNAMIX_USERNAME: "u", TEAMDYNAMIX_PASSWORD: "p" });
    expect(getConfig().auth.method).toBe("admin");
  });

  it("honors an explicit auth method", () => {
    withEnv({ ...REQUIRED, TEAMDYNAMIX_USERNAME: "u", TEAMDYNAMIX_PASSWORD: "p", TEAMDYNAMIX_AUTH_METHOD: "user" });
    expect(getConfig().auth.method).toBe("user");
  });

  it("rejects an explicit auth method without matching credentials", () => {
    withEnv({ ...REQUIRED, TEAMDYNAMIX_AUTH_METHOD: "user" });
    expect(() => getConfig()).toThrow(ConfigError);
  });

  it("rejects missing credentials", () => {
    withEnv({ TEAMDYNAMIX_BASE_URL: REQUIRED.TEAMDYNAMIX_BASE_URL });
    expect(() => getConfig()).toThrow(/No TeamDynamix credentials configured/);
  });

  it("rejects a missing base URL", () => {
    withEnv({ TEAMDYNAMIX_BEID: "b", TEAMDYNAMIX_WS_KEY: "k" });
    expect(() => getConfig()).toThrow(ConfigError);
  });

  it("requires a bearer token when bound to a non-loopback host over http", () => {
    withEnv({ ...REQUIRED, TRANSPORT: "http", HOST: "0.0.0.0" });
    expect(() => getConfig()).toThrow(/MCP_AUTH_TOKEN is required/);
  });

  it("accepts an external Hermes SSO deployment only on an authenticated loopback HTTP endpoint", () => {
    withEnv({
      TEAMDYNAMIX_BASE_URL: REQUIRED.TEAMDYNAMIX_BASE_URL,
      TEAMDYNAMIX_AUTH_METHOD: "sso",
      TEAMDYNAMIX_MCP_DEPLOYMENT: "external",
      TEAMDYNAMIX_SSO_EXPECTED_USER: "person@example.edu",
      TEAMDYNAMIX_SSO_CDP_ENDPOINT: "http://127.0.0.1:9222",
      TRANSPORT: "http",
      HOST: "127.0.0.1",
      MCP_AUTH_TOKEN: "separate-mcp-secret",
    });
    expect(getConfig().auth).toMatchObject({ method: "sso", deployment: "external" });
  });

  it.each([
    [{ TEAMDYNAMIX_AUTH_METHOD: "sso", TEAMDYNAMIX_MCP_DEPLOYMENT: "external" }, /EXPECTED_USER/i],
    [{ TEAMDYNAMIX_AUTH_METHOD: "sso", TEAMDYNAMIX_MCP_DEPLOYMENT: "external", TEAMDYNAMIX_SSO_EXPECTED_USER: "p", TRANSPORT: "http" }, /MCP_AUTH_TOKEN/i],
    [{ TEAMDYNAMIX_AUTH_METHOD: "sso", TEAMDYNAMIX_MCP_DEPLOYMENT: "external", TEAMDYNAMIX_SSO_EXPECTED_USER: "p", MCP_AUTH_TOKEN: "x" }, /HTTP/i],
    [{ TEAMDYNAMIX_AUTH_METHOD: "sso", TEAMDYNAMIX_MCP_DEPLOYMENT: "external", TEAMDYNAMIX_SSO_EXPECTED_USER: "p", MCP_AUTH_TOKEN: "x", TRANSPORT: "http", TEAMDYNAMIX_SSO_CDP_ENDPOINT: "https://remote.example" }, /loopback CDP/i],
    [{ TEAMDYNAMIX_MCP_DEPLOYMENT: "external", TEAMDYNAMIX_SSO_EXPECTED_USER: "p", MCP_AUTH_TOKEN: "x", TRANSPORT: "http", TEAMDYNAMIX_SSO_CDP_ENDPOINT: "http://127.0.0.1:9222", TEAMDYNAMIX_AUTH_METHOD: "admin" }, /requires TEAMDYNAMIX_AUTH_METHOD=sso/i],
  ])("rejects an invalid external Hermes configuration", (overrides, expected) => {
    withEnv({ ...REQUIRED, ...overrides });
    expect(() => getConfig()).toThrow(expected);
  });

  it("applies documented defaults", () => {
    const config = getConfig();
    expect(config.http.timeoutMs).toBe(15_000);
    expect(config.http.rateLimit).toBe(30);
    expect(config.cache.referenceTtlMs).toBe(600_000);
    expect(config.cache.searchTtlMs).toBe(60_000);
    expect(config.readOnly).toBe(false);
    expect(config.transport).toBe("stdio");
  });

  it("treats only the exact string 'true' as read-only", () => {
    withEnv({ ...REQUIRED, TEAMDYNAMIX_READ_ONLY: "TRUE" });
    expect(getConfig().readOnly).toBe(false);
    withEnv({ ...REQUIRED, TEAMDYNAMIX_READ_ONLY: "true" });
    expect(getConfig().readOnly).toBe(true);
  });

  it("parses list-valued host and origin allowlists", () => {
    withEnv({ ...REQUIRED, MCP_ALLOWED_HOSTS: "a.example.com, b.example.com", MCP_ALLOWED_ORIGINS: "https://app.example.com" });
    expect(getConfig().server.allowedHosts).toEqual(["a.example.com", "b.example.com"]);
    expect(getConfig().server.allowedOrigins).toEqual(["https://app.example.com"]);
  });
});

describe("state home resolution", () => {
  it("is a pure function of the parsed environment", async () => {
    const { resolveTdxHome, parseCliEnv, isLoopbackHost } = await import("../src/config.js");
    const { join } = await import("node:path");
    expect(resolveTdxHome({ TDX_HOME: "/x" }, "linux", "/h")).toBe("/x");
    expect(resolveTdxHome({}, "linux", "/h")).toBe(join("/h", ".local", "state", "tdx-mcp"));
    expect(resolveTdxHome({ XDG_STATE_HOME: "/s" }, "linux", "/h")).toBe(join("/s", "tdx-mcp"));
    expect(resolveTdxHome({ LOCALAPPDATA: "C:/L" }, "win32", "C:/u")).toBe(join("C:/L", "tdx-mcp"));
    expect(resolveTdxHome({}, "win32", "/u")).toBe(join("/u", "AppData", "Local", "tdx-mcp"));
    expect(parseCliEnv({ TDX_HOME: "  /y  ", TEAMDYNAMIX_SSO_EXPECTED_USER: " " }).TDX_HOME).toBe("/y");
    expect(parseCliEnv({ TEAMDYNAMIX_SSO_EXPECTED_USER: " " }).TEAMDYNAMIX_SSO_EXPECTED_USER).toBeUndefined();
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
  });
});
