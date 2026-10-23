import { createHash } from "node:crypto";
import { join } from "node:path";
import { getTdxHome } from "../config.js";

function stateDigest(apiBaseUrl: string, expectedUser?: string): string {
  return createHash("sha256")
    .update(`${apiBaseUrl.replace(/\/+$/, "").toLowerCase()}|${expectedUser?.trim().toLowerCase() ?? ""}`)
    .digest("hex")
    .slice(0, 16);
}

/** One token file per Web API realm and expected user, so identities cannot share state. */
export function ssoTokenPath(apiBaseUrl: string, expectedUser?: string): string {
  const digest = stateDigest(apiBaseUrl, expectedUser);
  return join(getTdxHome(), "tokens", `sso-${digest}.json`);
}

/** Dedicated browser profile per Web API root; holds only that realm's IdP session cookie. */
export function browserProfileDir(apiBaseUrl: string, expectedUser?: string): string {
  const digest = stateDigest(apiBaseUrl, expectedUser);
  return join(getTdxHome(), "browser-profiles", `sso-${digest}`);
}
