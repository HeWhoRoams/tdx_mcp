import axios from "axios";
import { describe, expect, it, vi } from "vitest";
import { ServiceAccountAuthorization, decodeJwtExpiryMs } from "../src/auth/service-account.js";
import type { StoredToken, TokenStore } from "../src/auth/token-store.js";
import { TeamDynamixAuthError } from "../src/services/errors.js";

const jwt = (expSecondsFromNow: number, tag = "t") =>
  `h.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow, tag })).toString("base64url")}.s`;

function memoryStore(initial?: StoredToken): TokenStore & { current: StoredToken | undefined } {
  const store = {
    current: initial,
    read: () => store.current,
    write: (token: StoredToken) => void (store.current = token),
    clear: () => void (store.current = undefined),
  };
  return store;
}

const admin = { method: "admin" as const, beid: "test-beid", wsKey: "test-key" };
const user = { method: "user" as const, username: "test-user", password: "test-pass" };

function http(replies: Array<string | Error>) {
  let call = 0;
  const post = vi.fn(async (..._args: unknown[]) => {
    const next = replies[Math.min(call, replies.length - 1)]!;
    call += 1;
    if (next instanceof Error) throw next;
    return { status: 200, data: next };
  });
  return { post } as unknown as Pick<import("axios").AxiosInstance, "post"> & { post: typeof post };
}

describe("ServiceAccountAuthorization", () => {
  it("logs in with the admin body and sends a bearer header", async () => {
    const client = http([jwt(3600)]);
    const auth = new ServiceAccountAuthorization(admin, client, memoryStore());
    const { header } = await auth.authorize();
    expect(header).toMatch(/^Bearer h\./);
    expect(client.post).toHaveBeenCalledWith("/auth/loginadmin", { BEID: "test-beid", WebServicesKey: "test-key" }, { maxRedirects: 0 });
  });

  it("logs in with the user body", async () => {
    const client = http([jwt(3600)]);
    await new ServiceAccountAuthorization(user, client, memoryStore()).authorize();
    expect(client.post).toHaveBeenCalledWith("/auth/login", { username: "test-user", password: "test-pass" }, { maxRedirects: 0 });
  });

  it("reuses a valid cached token and refreshes one that is about to expire", async () => {
    const client = http([jwt(3600, "fresh")]);
    const valid = memoryStore({ token: jwt(3600, "cached"), expiresAtMs: Date.now() + 3_600_000 });
    await new ServiceAccountAuthorization(admin, client, valid).authorize();
    expect(client.post).not.toHaveBeenCalled();

    const stale = memoryStore({ token: jwt(30, "old"), expiresAtMs: Date.now() + 30_000 }); // inside the 60 s buffer
    await new ServiceAccountAuthorization(admin, client, stale).authorize();
    expect(client.post).toHaveBeenCalledTimes(1);
  });

  it("shares one login between concurrent callers", async () => {
    const client = http([jwt(3600)]);
    const auth = new ServiceAccountAuthorization(admin, client, memoryStore());
    await Promise.all([auth.authorize(), auth.authorize(), auth.authorize()]);
    expect(client.post).toHaveBeenCalledTimes(1);
  });

  it("rejects a response that is not a JWT, and wraps transport failures", async () => {
    await expect(new ServiceAccountAuthorization(admin, http(["<html>login page</html>"]), memoryStore()).authorize()).rejects.toThrow(
      /did not return a JWT/
    );
    await expect(new ServiceAccountAuthorization(admin, http([new Error("network down")]), memoryStore()).authorize()).rejects.toThrow(
      TeamDynamixAuthError
    );
  });

  it("falls back to a default lifetime when the token has no exp claim", async () => {
    const store = memoryStore();
    await new ServiceAccountAuthorization(admin, http(["h.e30.s"]), store).authorize();
    expect(store.current!.expiresAtMs).toBeGreaterThan(Date.now() + 60 * 60 * 1000);
  });

  it("discards only the token that was rejected", async () => {
    const client = http([jwt(3600, "one"), jwt(3600, "two")]);
    const store = memoryStore();
    const auth = new ServiceAccountAuthorization(admin, client, store);
    const first = await auth.authorize();
    expect(await auth.reportUnauthorized(first.fingerprint)).toBe("expired");
    expect(store.current).toBeUndefined();

    const second = await auth.authorize();
    expect(second.fingerprint).not.toBe(first.fingerprint);
    // A late report about the first token must not throw away the second one.
    await auth.reportUnauthorized(first.fingerprint);
    expect(store.current).toBeDefined();
  });

  it("retries once and then hands back the rejection as it was", () => {
    const auth = new ServiceAccountAuthorization(admin, http([jwt(3600)]), memoryStore());
    expect(auth.maxReauthorizations).toBe(1);
    const rejection = new Error("401");
    expect(auth.exhausted(rejection)).toBe(rejection);
    expect(auth.exhausted("x")).toBeInstanceOf(Error);
  });

  it("never exposes the token in the fingerprint", async () => {
    const token = jwt(3600, "secret-tag");
    const { fingerprint } = await new ServiceAccountAuthorization(admin, http([token]), memoryStore()).authorize();
    expect(fingerprint).toHaveLength(12);
    expect(token).not.toContain(fingerprint);
  });
});

describe("decodeJwtExpiryMs", () => {
  it("is exported from the adapter module", () => {
    expect(typeof decodeJwtExpiryMs).toBe("function");
  });
});

void axios;
