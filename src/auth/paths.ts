import { join } from "node:path";
import { getTdxHome } from "../config.js";
import { bindingDigest, type IdentityBinding } from "./identity-binding.js";

/** One token file per binding, so identities cannot share state. */
export function ssoTokenPath(binding: IdentityBinding): string {
  return join(getTdxHome(), "tokens", `sso-${bindingDigest(binding)}.json`);
}

/** Dedicated browser profile per binding; holds only that realm's IdP session cookie. */
export function browserProfileDir(binding: IdentityBinding): string {
  return join(getTdxHome(), "browser-profiles", `sso-${bindingDigest(binding)}`);
}
