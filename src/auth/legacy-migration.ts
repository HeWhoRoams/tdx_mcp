import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { StoredToken } from "../services/token-store.js";
import type { IdentityBinding } from "./identity-binding.js";

export type MigrationOutcome = "migrated" | "no-legacy-state" | "already-migrated" | "untouched";

export interface LegacyMigrationDeps {
  binding: IdentityBinding;
  stateHome: string;
  /** Current token file; migration only runs while it is absent. */
  tokenPath: string;
  currentProfileDir: string;
  /** False once the realm has any recorded history (a login, logout or block): migration must not undo it. */
  isPristine(): boolean;
  /** Validates against /auth/getuser and the Expected user; throws if the token is not that user's. */
  validate(token: string): Promise<StoredToken>;
  /** Stores the verified token as an interactive login would. */
  commit(token: StoredToken): void;
  audit(event: "state_migrated" | "state_migration_skipped", fields?: Record<string, unknown>): void;
  now?: () => number;
}

/** The first release keyed state by the realm alone. */
function legacyDigest(realm: string): string {
  return createHash("sha256").update(realm.replace(/\/+$/, "").toLowerCase()).digest("hex").slice(0, 16);
}

export function legacyTokenPath(stateHome: string, realm: string): string {
  return join(stateHome, "tokens", `sso-${legacyDigest(realm)}.json`);
}

function legacyProfileCandidates(stateHome: string, realm: string): string[] {
  return [join(stateHome, "browser-profiles", `sso-${legacyDigest(realm)}`), join(stateHome, "browser-profile")];
}

function profileInUse(dir: string): boolean {
  return ["SingletonLock", "SingletonSocket", "SingletonCookie", "lockfile"].some((name) => existsSync(join(dir, name)));
}

/**
 * Carries a first-release sign-in forward, but only when it provably belongs to the person this
 * state is bound to. Without an Expected user, or on any doubt, the legacy files are left alone
 * and the person simply signs in again.
 */
export async function migrateLegacyState(deps: LegacyMigrationDeps): Promise<MigrationOutcome> {
  const { binding, stateHome } = deps;
  const now = deps.now ?? Date.now;
  if (existsSync(deps.tokenPath)) return "already-migrated";
  const legacyPath = legacyTokenPath(stateHome, binding.realm);
  if (!existsSync(legacyPath)) return "no-legacy-state";
  const skip = (reason: string): MigrationOutcome => {
    deps.audit("state_migration_skipped", { reason });
    return "untouched";
  };
  if (!binding.expectedUser) return skip("no-expected-user");
  if (!deps.isPristine()) return skip("state-already-recorded");

  let legacy: StoredToken;
  try {
    legacy = JSON.parse(readFileSync(legacyPath, "utf8")) as StoredToken;
    if (typeof legacy.token !== "string" || typeof legacy.expiresAtMs !== "number") return skip("unreadable");
  } catch {
    return skip("unreadable");
  }
  if (legacy.expiresAtMs <= now()) return skip("expired");

  let verified: StoredToken;
  try {
    verified = await deps.validate(legacy.token);
  } catch {
    return skip("not-verified-as-expected-user");
  }
  if (existsSync(deps.tokenPath)) return "already-migrated"; // another process won while we validated
  if (!deps.isPristine()) return skip("state-changed-during-validation"); // a logout or login happened meanwhile

  deps.commit(verified);
  try {
    renameSync(legacyPath, `${legacyPath}.migrated`);
  } catch {
    // The new file exists, so the legacy one is no longer read; leaving it is harmless.
  }

  let profileMoved = false;
  if (!existsSync(deps.currentProfileDir)) {
    for (const candidate of legacyProfileCandidates(stateHome, binding.realm)) {
      if (candidate === deps.currentProfileDir || !existsSync(candidate) || profileInUse(candidate)) continue;
      try {
        renameSync(candidate, deps.currentProfileDir);
        profileMoved = true;
        break;
      } catch {
        // Keep the old profile; the person can sign in again to create a new one.
      }
    }
  }
  deps.audit("state_migrated", { profileMoved });
  return "migrated";
}
