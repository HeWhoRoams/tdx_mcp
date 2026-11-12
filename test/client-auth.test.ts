import axios, { AxiosError, AxiosHeaders } from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfig } from "../src/config.js";
import { resetCaches } from "../src/services/cache.js";
import { getClient, resetClient } from "../src/services/client.js";

/**
 * Service-account authentication as the client's callers observe it: logins, re-login after a
 * rejected token, and single-flight. Driven through a stubbed transport so it survives moving the
 * login code out of the client.
 */

function setEnv(): void {
  process.env.TEAMDYNAMIX_BASE_URL = "https://example.teamdynamix.com";
  process.env.TEAMDYNAMIX_BEID = "test-beid";
  process.env.TEAMDYNAMIX_WS_KEY = "test-key";
  delete process.env.TEAMDYNAMIX_AUTH_METHOD;
  delete process.env.TEAMDYNAMIX_USERNAME;
  delete process.env.TEAMDYNAMIX_PASSWORD;
  delete process.env.TEAMDYNAMIX_READ_ONLY;
  delete process.env.TEAMDYNAMIX_DEFAULT_APP_ID;
  resetConfig();
  resetCaches();
  resetClient();
}

const jwt = (tag: string) =>
  `h.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, tag })).toString("base64url")}.s`;

function unauthorized(): AxiosError {
  const error = new AxiosError("unauthorized");
  error.response = { status: 401, statusText: "", data: "", headers: new AxiosHeaders(), config: { headers: new AxiosHeaders() } };
  return error;
}

function stubTransport(script: Array<"401" | { data: unknown }>) {
  let logins = 0;
  let call = 0;
  const seenAuthorization: string[] = [];
  const post = vi.fn(async () => ({ status: 200, data: jwt(`login-${(logins += 1)}`) }));
  const request = vi.fn(async (config: { headers: { Authorization: string } }) => {
    seenAuthorization.push(config.headers.Authorization);
    const next = script[Math.min(call, script.length - 1)];
    call += 1;
    if (next === "401") throw unauthorized();
    return { status: 200, data: next.data };
  });
  vi.spyOn(axios, "create").mockReturnValue({ request, post } as unknown as ReturnType<typeof axios.create>);
  return { post, request, seenAuthorization };
}

beforeEach(setEnv);
afterEach(() => {
  vi.restoreAllMocks();
  resetClient();
});

describe("service-account authentication", () => {
  it("logs in once and reuses the token", async () => {
    const { post, request } = stubTransport([{ data: { ok: 1 } }]);
    await getClient().request("/x");
    await getClient().request("/y");
    expect(post).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("re-logs in and retries once when the token is rejected", async () => {
    const { post, request, seenAuthorization } = stubTransport(["401", { data: { ok: 2 } }]);
    await expect(getClient().request("/x")).resolves.toEqual({ ok: 2 });
    expect(post).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledTimes(2);
    expect(seenAuthorization[0]).not.toBe(seenAuthorization[1]);
  });

  it("gives up after one retry and surfaces the rejection", async () => {
    const { post, request } = stubTransport(["401"]);
    await expect(getClient().request("/x")).rejects.toThrow();
    expect(post).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("shares one login between concurrent first requests", async () => {
    const { post } = stubTransport([{ data: { ok: 3 } }]);
    await Promise.all([getClient().request("/a"), getClient().request("/b"), getClient().request("/c")]);
    expect(post).toHaveBeenCalledTimes(1);
  });
});
