import { createHash } from "node:crypto";

/**
 * What a sign-in is bound to: one Web API realm (sandbox and production are different
 * realms) and, optionally, the one person expected to be signed in. Token files, the
 * browser profile and cache namespaces are all derived from this, never from loose strings.
 */
export interface IdentityBinding {
  /** Web API root, e.g. https://org.teamdynamix.com/SBTDWebApi/api */
  realm: string;
  /** Email or username, compared case-insensitively. */
  expectedUser?: string;
}

export function bindingOf(realm: string, expectedUser?: string): IdentityBinding {
  return { realm, ...(expectedUser ? { expectedUser } : {}) };
}

/** Stable, filesystem-safe identifier for a binding. The one implementation. */
export function bindingDigest(binding: IdentityBinding): string {
  return createHash("sha256")
    .update(`${binding.realm.replace(/\/+$/, "").toLowerCase()}|${binding.expectedUser?.trim().toLowerCase() ?? ""}`)
    .digest("hex")
    .slice(0, 16);
}
