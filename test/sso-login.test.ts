import axios from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildStoredToken, decodeJwtClaims, extractJwt, loginSsoUrl, matchesExpectedUser, ssoLoginRequiredMessage } from "../src/auth/sso-login.js";

const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1bmlxdWVfbmFtZSI6Im5pbGVzMXRqQGNtaWNoLmVkdSIsInRkeF9lbnRpdHkiOiIyMTkiLCJ0ZHhfcGFydGl0aW9uIjoiOCIsImV4cCI6MTc5Mjg1OTU3N30.sig-_x";

describe("extractJwt", () => {
  it("finds a bare token", () => expect(extractJwt(JWT)).toBe(JWT));
  it("finds a JSON-quoted token", () => expect(extractJwt(`"${JWT}"`)).toBe(JWT));
  it("finds a token wrapped in HTML", () => expect(extractJwt(`<html><body><pre>${JWT}</pre></body></html>`)).toBe(JWT));
  it("returns undefined for a login page", () => expect(extractJwt("<html>Sign in with your CMU account</html>")).toBeUndefined());
  it("returns the first token when there are two", () => expect(extractJwt(`${JWT} eyJa.eyJb.c`)).toBe(JWT));
});

describe("decodeJwtClaims", () => {
  it("reads the identity and tenant claims", () => {
    const claims = decodeJwtClaims(JWT);
    expect(claims?.unique_name).toBe("niles1tj@cmich.edu");
    expect(claims?.tdx_entity).toBe("219");
    expect(claims?.exp).toBe(1792859577);
  });
  it("returns undefined for garbage", () => expect(decodeJwtClaims("nope")).toBeUndefined());
});

describe("matchesExpectedUser", () => {
  it("matches case-insensitively on any identity", () => {
    expect(matchesExpectedUser("NILES1TJ@cmich.edu", [undefined, "niles1tj@cmich.edu"])).toBe(true);
  });
  it("rejects someone else", () => expect(matchesExpectedUser("a@cmich.edu", ["b@cmich.edu"])).toBe(false));
});

describe("messages and urls", () => {
  it("builds the loginsso url without double slashes", () => {
    expect(loginSsoUrl("https://x.teamdynamix.com/SBTDWebApi/api/")).toBe("https://x.teamdynamix.com/SBTDWebApi/api/auth/loginsso");
  });
  it("labels the environment and tells the model what to ask for", () => {
    const message = ssoLoginRequiredMessage("https://x.teamdynamix.com/SBTDWebApi/api");
    expect(message).toContain("sandbox");
    expect(message).toContain("npm run login");
  });
});

describe("buildStoredToken failure kinds", () => {
  afterEach(() => vi.restoreAllMocks());
  const API = "https://example.teamdynamix.com/SBTDWebApi/api";
  const future = () => {
    const payload = Buffer.from(JSON.stringify({ unique_name: "a@x.edu", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
    return `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
  };
  const httpError = (status?: number) =>
    Object.assign(new Error("x"), { isAxiosError: true, ...(status ? { response: { status } } : {}) });

  it.each([
    [undefined, "transient"],
    [429, "transient"],
    [503, "transient"],
    [401, "invalid-token"],
    [302, "invalid-token"],
  ] as const)("getuser %s is %s", async (status, kind) => {
    vi.spyOn(axios, "get").mockRejectedValue(httpError(status));
    await expect(buildStoredToken(future(), API, { method: "sso" })).rejects.toMatchObject({ kind });
  });

  it("expected-user and pinned-UID mismatches are identity-mismatch", async () => {
    vi.spyOn(axios, "get").mockResolvedValue({ data: { UID: "u2", PrimaryEmail: "a@x.edu", FullName: "A" } });
    await expect(buildStoredToken(future(), API, { method: "sso", expectedUser: "b@x.edu" })).rejects.toMatchObject({ kind: "identity-mismatch" });
    await expect(
      buildStoredToken(future(), API, { method: "sso", requireSameUser: true, previous: { token: "t", expiresAtMs: 1, uid: "u1" } })
    ).rejects.toMatchObject({ kind: "identity-mismatch" });
  });
});
