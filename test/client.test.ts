import { describe, expect, it } from "vitest";
import { decodeJwtExpiryMs, handleApiError, parseRetryAfterMs, TeamDynamixAuthError } from "../src/services/client.js";
import { AxiosError, AxiosHeaders } from "axios";

function axiosErrorWithStatus(status: number, data?: unknown): AxiosError {
  const error = new AxiosError("request failed");
  error.response = {
    status,
    statusText: "",
    data,
    headers: new AxiosHeaders(),
    config: { headers: new AxiosHeaders() },
  };
  return error;
}

describe("parseRetryAfterMs", () => {
  it("parses delta-seconds", () => {
    expect(parseRetryAfterMs("30")).toBe(30_000);
  });

  it("parses an HTTP date", () => {
    const future = new Date(Date.now() + 5_000).toUTCString();
    const parsed = parseRetryAfterMs(future);
    expect(parsed).toBeGreaterThan(0);
    expect(parsed).toBeLessThanOrEqual(6_000);
  });

  it("never returns a negative delay for a past date", () => {
    expect(parseRetryAfterMs(new Date(Date.now() - 60_000).toUTCString())).toBe(0);
  });

  it("returns undefined for missing or unparsable values", () => {
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs("")).toBeUndefined();
    expect(parseRetryAfterMs("not-a-date")).toBeUndefined();
  });
});

describe("decodeJwtExpiryMs", () => {
  it("reads the exp claim", () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const payload = Buffer.from(JSON.stringify({ exp }), "utf8").toString("base64url");
    expect(decodeJwtExpiryMs(`header.${payload}.signature`)).toBe(exp * 1000);
  });

  it("returns undefined for malformed tokens", () => {
    expect(decodeJwtExpiryMs("not-a-jwt")).toBeUndefined();
    expect(decodeJwtExpiryMs("a.!!!.c")).toBeUndefined();
  });
});

describe("handleApiError", () => {
  it("surfaces auth errors verbatim", () => {
    expect(handleApiError(new TeamDynamixAuthError("bad credentials"))).toBe("Error: bad credentials");
  });

  it.each([
    [400, /rejected the request as invalid/],
    [401, /Not authenticated/],
    [403, /Permission denied/],
    [404, /Resource not found/],
    [429, /Rate limit exceeded/],
    [500, /status 500/],
  ])("maps HTTP %i to an actionable message", (status, pattern) => {
    expect(handleApiError(axiosErrorWithStatus(status))).toMatch(pattern);
  });

  it("includes the response body for 400s", () => {
    expect(handleApiError(axiosErrorWithStatus(400, "TypeID is required"))).toContain("TypeID is required");
  });

  it("explains timeouts", () => {
    const error = new AxiosError("timeout");
    error.code = "ECONNABORTED";
    expect(handleApiError(error)).toMatch(/timed out/);
  });

  it("falls back for unknown errors", () => {
    expect(handleApiError(new Error("boom"))).toBe("Error: Unexpected error occurred: boom");
  });
});
