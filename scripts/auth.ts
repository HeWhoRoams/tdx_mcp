/**
 * auth.ts
 *
 * Shared TeamDynamix authentication helpers for CLI scripts.
 * Centralises credential resolution and token acquisition so changes
 * to login behaviour only need to be made in one place.
 */

import "dotenv/config";
import { type AxiosInstance } from "axios";
import { bindingOf } from "../src/auth/identity-binding.js";
import { ssoTokenPath } from "../src/auth/paths.js";
import { SsoTokenStore } from "../src/services/token-store.js";
import { getApiBaseUrl, parseCliEnv } from "../src/config.js";

const cliEnv = () => parseCliEnv();

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
  const env = cliEnv();
  const explicit = env.TEAMDYNAMIX_AUTH_METHOD?.toLowerCase();
  const hasAdmin = Boolean(env.TEAMDYNAMIX_BEID && env.TEAMDYNAMIX_WS_KEY);
  const hasUser = Boolean(env.TEAMDYNAMIX_USERNAME && env.TEAMDYNAMIX_PASSWORD);
  if (explicit === "sso") return "sso";
  if (explicit === "admin" && hasAdmin) return "admin";
  if (explicit === "user" && hasUser) return "user";
  if (hasAdmin) return "admin";
  if (hasUser) return "user";
  throw new Error(
    "No credentials found.\n" +
    "Set TEAMDYNAMIX_BEID + TEAMDYNAMIX_WS_KEY  (admin service account)\n" +
    "  OR  TEAMDYNAMIX_USERNAME + TEAMDYNAMIX_PASSWORD  (user login)\n" +
    "in your .env or environment."
  );
}

export async function authenticate(http: AxiosInstance, method: "admin" | "user" | "sso"): Promise<string> {
  if (method === "sso") {
    const stored = new SsoTokenStore(ssoTokenPath(bindingOf(getApiBaseUrl(), cliEnv().TEAMDYNAMIX_SSO_EXPECTED_USER))).read();
    if (!stored || stored.expiresAtMs <= Date.now()) {
      throw new Error("No valid SSO sign-in saved for this environment. Run: npm run login");
    }
    return stored.token;
  }
  if (method === "admin") {
    const res = await http.post<string>(
      "/auth/loginadmin",
      {
        BEID: cliEnv().TEAMDYNAMIX_BEID,
        WebServicesKey: cliEnv().TEAMDYNAMIX_WS_KEY,
      },
      { maxRedirects: 0 }
    );
    return requireJwt(res.data);
  }
  const res = await http.post<string>(
    "/auth/login",
    {
      username: cliEnv().TEAMDYNAMIX_USERNAME,
      password: cliEnv().TEAMDYNAMIX_PASSWORD,
    },
    { maxRedirects: 0 }
  );
  return requireJwt(res.data);
}
