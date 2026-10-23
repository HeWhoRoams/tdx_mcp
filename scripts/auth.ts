/**
 * auth.ts
 *
 * Shared TeamDynamix authentication helpers for CLI scripts.
 * Centralises credential resolution and token acquisition so changes
 * to login behaviour only need to be made in one place.
 */

import "dotenv/config";
import { type AxiosInstance } from "axios";
import { ssoTokenPath } from "../src/auth/paths.js";
import { SsoTokenStore } from "../src/services/token-store.js";
import { getApiBaseUrl } from "../src/config.js";

function requireJwt(value: unknown): string {
  const token = typeof value === "string" ? value.trim() : String(value);
  if (token.split(".").length !== 3) {
    throw new Error(
      "TeamDynamix authentication did not return a JWT. The API URL may be redirecting to the web login page."
    );
  }
  return token;
}

export function getAuthMethod(): "admin" | "user" | "sso" {
  if (process.env.TEAMDYNAMIX_AUTH_METHOD?.toLowerCase() === "sso") return "sso";
  const explicit = process.env.TEAMDYNAMIX_AUTH_METHOD?.toLowerCase();
  if (explicit === "admin" && process.env.TEAMDYNAMIX_BEID && process.env.TEAMDYNAMIX_WS_KEY) return "admin";
  if (explicit === "user"  && process.env.TEAMDYNAMIX_USERNAME && process.env.TEAMDYNAMIX_PASSWORD) return "user";
  if (process.env.TEAMDYNAMIX_BEID && process.env.TEAMDYNAMIX_WS_KEY) return "admin";
  if (process.env.TEAMDYNAMIX_USERNAME && process.env.TEAMDYNAMIX_PASSWORD) return "user";
  throw new Error(
    "No credentials found.\n" +
    "Set TEAMDYNAMIX_BEID + TEAMDYNAMIX_WS_KEY  (admin service account)\n" +
    "  OR  TEAMDYNAMIX_USERNAME + TEAMDYNAMIX_PASSWORD  (user login)\n" +
    "in your .env or environment."
  );
}

export async function authenticate(http: AxiosInstance, method: "admin" | "user" | "sso"): Promise<string> {
  if (method === "sso") {
    const stored = new SsoTokenStore(ssoTokenPath(getApiBaseUrl(), process.env.TEAMDYNAMIX_SSO_EXPECTED_USER)).read();
    if (!stored || stored.expiresAtMs <= Date.now()) {
      throw new Error("No valid SSO sign-in saved for this environment. Run: npm run login");
    }
    return stored.token;
  }
  if (method === "admin") {
    const res = await http.post<string>(
      "/auth/loginadmin",
      {
        BEID: process.env.TEAMDYNAMIX_BEID,
        WebServicesKey: process.env.TEAMDYNAMIX_WS_KEY,
      },
      { maxRedirects: 0 }
    );
    return requireJwt(res.data);
  }
  const res = await http.post<string>(
    "/auth/login",
    {
      username: process.env.TEAMDYNAMIX_USERNAME,
      password: process.env.TEAMDYNAMIX_PASSWORD,
    },
    { maxRedirects: 0 }
  );
  return requireJwt(res.data);
}
