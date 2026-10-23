import axios from "axios";
import type { StoredToken } from "../services/token-store.js";

export class SsoLoginError extends Error {}
/** The IdP requires a person to complete an interactive sign-in or MFA step. */
export class SsoPolicyError extends SsoLoginError {}

const JWT_PATTERN = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;

/** Accepts a bare, JSON-quoted, or HTML-wrapped body and returns the first JWT in it. */
export function extractJwt(body: string): string | undefined {
  return JWT_PATTERN.exec(body)?.[0];
}

export interface JwtClaims {
  unique_name?: string;
  tdx_entity?: string;
  tdx_partition?: string;
  exp?: number;
  iat?: number;
  [claim: string]: unknown;
}

/** Reads the payload without verifying it; TeamDynamix verifies the signature on every call. */
export function decodeJwtClaims(token: string): JwtClaims | undefined {
  try {
    const payload = token.split(".")[1];
    if (!payload) return undefined;
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as JwtClaims;
  } catch {
    return undefined;
  }
}

export function loginSsoUrl(apiBaseUrl: string): string {
  return `${apiBaseUrl.replace(/\/+$/, "")}/auth/loginsso`;
}

export function environmentLabel(apiBaseUrl: string): "sandbox" | "production" {
  return /\/sb\w*webapi/i.test(apiBaseUrl) ? "sandbox" : "production";
}

export function ssoLoginRequiredMessage(apiBaseUrl: string, stored?: StoredToken): string {
  const why = stored
    ? `the saved sign-in expired at ${new Date(stored.expiresAtMs).toLocaleString()}`
    : "no saved sign-in was found";
  return (
    `TeamDynamix sign-in required (${environmentLabel(apiBaseUrl)}): ${why}. ` +
    "Ask the user to run `npm run login` in the tdx_mcp folder, then retry."
  );
}

/** True when `expected` names the signed-in person (email or username, any case). */
export function matchesExpectedUser(expected: string, identities: Array<string | undefined>): boolean {
  const wanted = expected.trim().toLowerCase();
  return identities.some((value) => typeof value === "string" && value.trim().toLowerCase() === wanted);
}

interface GetUserResponse {
  UID?: string;
  UserName?: string;
  FullName?: string;
  PrimaryEmail?: string;
  AlertEmail?: string;
}

/**
 * Confirms a freshly captured token with /auth/getuser, checks it belongs to the
 * expected person and tenant, and returns the record to store. Throws before
 * anything is saved if any check fails.
 */
export async function buildStoredToken(
  token: string,
  apiBaseUrl: string,
  options: { expectedUser?: string; method: "sso" | "paste"; previous?: StoredToken }
): Promise<StoredToken> {
  const claims = decodeJwtClaims(token);
  if (!claims) throw new SsoLoginError("That value is not a decodable JWT.");

  if (options.expectedUser && claims.unique_name && !matchesExpectedUser(options.expectedUser, [claims.unique_name])) {
    throw new SsoLoginError(
      `Signed in as ${claims.unique_name}, but TEAMDYNAMIX_SSO_EXPECTED_USER is ${options.expectedUser}. Nothing was saved.`
    );
  }

  const expiresAtMs = typeof claims.exp === "number" ? claims.exp * 1000 : Date.now() + 23 * 60 * 60 * 1000;
  if (expiresAtMs <= Date.now()) throw new SsoLoginError("That token has already expired.");

  let user: GetUserResponse;
  try {
    const response = await axios.get<GetUserResponse>(`${apiBaseUrl.replace(/\/+$/, "")}/auth/getuser`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15_000,
      maxRedirects: 0,
    });
    user = response.data;
  } catch (error) {
    const status = axios.isAxiosError(error) ? error.response?.status : undefined;
    throw new SsoLoginError(
      `TeamDynamix rejected the token at /auth/getuser (${status ?? "no response"}). ` +
        "Check that it came from the same environment (TDWebApi vs SBTDWebApi) as TEAMDYNAMIX_BASE_URL."
    );
  }

  if (typeof user?.UID !== "string") throw new SsoLoginError("/auth/getuser did not return a user.");

  if (
    options.expectedUser &&
    !matchesExpectedUser(options.expectedUser, [user.PrimaryEmail, user.AlertEmail, user.UserName, claims.unique_name])
  ) {
    throw new SsoLoginError(
      `Signed in as ${user.FullName ?? user.UID}, but TEAMDYNAMIX_SSO_EXPECTED_USER is ${options.expectedUser}. Nothing was saved.`
    );
  }

  const previous = options.previous;
  if (
    previous?.entity !== undefined &&
    claims.tdx_entity !== undefined &&
    (previous.entity !== String(claims.tdx_entity) || previous.partition !== String(claims.tdx_partition))
  ) {
    throw new SsoLoginError("This token is for a different TeamDynamix tenant than the saved one. Run `npm run logout` first.");
  }

  return {
    token,
    expiresAtMs,
    uid: user.UID,
    ...(user.UserName ? { username: user.UserName } : {}),
    ...(user.FullName ? { fullName: user.FullName } : {}),
    ...(user.PrimaryEmail ? { email: user.PrimaryEmail } : {}),
    ...(claims.tdx_entity !== undefined ? { entity: String(claims.tdx_entity) } : {}),
    ...(claims.tdx_partition !== undefined ? { partition: String(claims.tdx_partition) } : {}),
    apiBaseUrl,
    obtainedAtMs: Date.now(),
    method: options.method,
  };
}

