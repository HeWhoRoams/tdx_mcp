/**
 * auth.ts
 *
 * Authentication for CLI scripts. It is the server's own login: the same configuration rules
 * (getConfig) and the same credential code (createAuthorization), so a script that signs in
 * proves the server would too.
 */

import "dotenv/config";
import { createAuthorization } from "../src/auth/sso-composition.js";
import { getConfig } from "../src/config.js";

/** The configured method, decided by the same rules as the server. */
export function getAuthMethod(): "admin" | "user" | "sso" {
  return getConfig().auth.method;
}

/** One ready Authorization header, obtained exactly as the server would. */
export async function authorizationHeader(): Promise<string> {
  const authorization = createAuthorization(getConfig());
  try {
    return (await authorization.authorize()).header;
  } finally {
    authorization.stop();
  }
}
