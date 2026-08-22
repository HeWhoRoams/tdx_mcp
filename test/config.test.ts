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
