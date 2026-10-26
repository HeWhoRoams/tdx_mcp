import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindingOf } from "../src/auth/identity-binding.js";
import { legacyTokenPath, migrateLegacyState } from "../src/auth/legacy-migration.js";
import type { StoredToken } from "../src/services/token-store.js";

const REALM = "https://x.teamdynamix.com/SBTDWebApi/api";
let home: string;
beforeEach(() => void (home = mkdtempSync(join(tmpdir(), "tdx-mig-"))));
afterEach(() => rmSync(home, { recursive: true, force: true }));

const legacyToken: StoredToken = { token: "legacy", expiresAtMs: Date.now() + 3_600_000, uid: "u1" };

function setup(options: { expectedUser?: string | undefined; legacy?: StoredToken | string | "none-written"; validate?: () => Promise<StoredToken> } = {}) {
  const binding = bindingOf(REALM, "expectedUser" in options ? options.expectedUser : "me@x.edu");
  const legacyPath = legacyTokenPath(home, REALM);
  mkdirSync(join(home, "tokens"), { recursive: true });
  if (options.legacy !== "none-written") {
    const body = options.legacy ?? legacyToken;
    writeFileSync(legacyPath, typeof body === "string" ? body : JSON.stringify(body));
  }
  const tokenPath = join(home, "tokens", "sso-new.json");
  const currentProfileDir = join(home, "browser-profiles", "sso-new");
  const commit = vi.fn((token: StoredToken) => writeFileSync(tokenPath, JSON.stringify(token)));
  const audit = vi.fn();
  const pristine = { value: true };
  const validate = vi.fn(options.validate ?? (async () => ({ ...legacyToken, token: "legacy", fullName: "Me" })));
  const run = () => migrateLegacyState({ binding, stateHome: home, tokenPath, currentProfileDir, isPristine: () => pristine.value, validate, commit, audit });
  return { pristine, run, commit, audit, validate, legacyPath, tokenPath, currentProfileDir };
}

describe("migrateLegacyState", () => {
  it("migrates a legacy token verified as the expected user, and moves the idle profile", async () => {
    const t = setup();
    const legacyProfile = join(home, "browser-profiles", "sso-" + legacyTokenPath(home, REALM).match(/sso-(\w+)\.json/)![1]);
    mkdirSync(legacyProfile, { recursive: true });
    writeFileSync(join(legacyProfile, "Cookies"), "c");

    await expect(t.run()).resolves.toBe("migrated");
    expect(t.commit).toHaveBeenCalledOnce();
    expect(existsSync(t.legacyPath)).toBe(false);
    expect(existsSync(`${t.legacyPath}.migrated`)).toBe(true);
    expect(readFileSync(join(t.currentProfileDir, "Cookies"), "utf8")).toBe("c");
    expect(t.audit).toHaveBeenCalledWith("state_migrated", { profileMoved: true });
  });

  it("leaves the profile alone while a browser holds it", async () => {
    const t = setup();
    const legacyProfile = join(home, "browser-profile");
    mkdirSync(legacyProfile, { recursive: true });
    writeFileSync(join(legacyProfile, "SingletonLock"), "x");
    await expect(t.run()).resolves.toBe("migrated");
    expect(existsSync(legacyProfile)).toBe(true);
    expect(existsSync(t.currentProfileDir)).toBe(false);
    expect(t.audit).toHaveBeenCalledWith("state_migrated", { profileMoved: false });
  });

  it("does nothing without an expected user", async () => {
    const t = setup({ expectedUser: undefined });
    await expect(t.run()).resolves.toBe("untouched");
    expect(t.validate).not.toHaveBeenCalled();
    expect(existsSync(t.legacyPath)).toBe(true);
    expect(t.audit).toHaveBeenCalledWith("state_migration_skipped", { reason: "no-expected-user" });
  });

  it("leaves legacy state untouched when it is not verified as the expected user", async () => {
    const t = setup({ validate: async () => { throw new Error("different user"); } });
    await expect(t.run()).resolves.toBe("untouched");
    expect(t.commit).not.toHaveBeenCalled();
    expect(existsSync(t.legacyPath)).toBe(true);
  });

  it("skips expired or unreadable legacy tokens without validating", async () => {
    const expired = setup({ legacy: { ...legacyToken, expiresAtMs: Date.now() - 1 } });
    await expect(expired.run()).resolves.toBe("untouched");
    expect(expired.validate).not.toHaveBeenCalled();
    writeFileSync(expired.legacyPath, "{ nope");
    await expect(expired.run()).resolves.toBe("untouched");
  });

  it("is idempotent: a second run finds the new file and does nothing", async () => {
    const t = setup();
    await t.run();
    await expect(t.run()).resolves.toBe("already-migrated");
    expect(t.commit).toHaveBeenCalledOnce();
  });

  it("never undoes a sign-out: recorded state means no migration", async () => {
    const t = setup();
    t.pristine.value = false; // the user already logged out (or in) in this realm
    await expect(t.run()).resolves.toBe("untouched");
    expect(t.validate).not.toHaveBeenCalled();
    expect(t.commit).not.toHaveBeenCalled();
    expect(t.audit).toHaveBeenCalledWith("state_migration_skipped", { reason: "state-already-recorded" });
  });

  it("backs out when a logout lands while the legacy token is being verified", async () => {
    let t!: ReturnType<typeof setup>;
    t = setup({ validate: async () => { t.pristine.value = false; return { ...legacyToken, token: "legacy" }; } });
    await expect(t.run()).resolves.toBe("untouched");
    expect(t.commit).not.toHaveBeenCalled();
  });

  it("reports when there is nothing to migrate", async () => {
    const t = setup({ legacy: "none-written" });
    await expect(t.run()).resolves.toBe("no-legacy-state");
  });
});
