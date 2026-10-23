import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CredentialState, FileStatePersistence, MemoryStatePersistence } from "../src/auth/credential-state.js";
import { SsoTokenStore, type StoredToken } from "../src/services/token-store.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tdx-state-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const NOW = 1_000_000;
const tok = (token: string, expiresAtMs = NOW + 3_600_000, uid = "u1"): StoredToken => ({ token, expiresAtMs, uid });

function fileBacked() {
  const store = new SsoTokenStore(join(dir, "sso.json"));
  const persistence = new FileStatePersistence(store.statePath, store.legacyMarkerPath);
  return { store, persistence, state: new CredentialState(store, persistence, () => NOW) };
}

describe("status", () => {
  it("covers all four states", () => {
    const memory = (token?: StoredToken) => {
      let current = token;
      const persistence = new MemoryStatePersistence();
      const state = new CredentialState(
        { read: () => current, write: (t) => void (current = t), clear: () => void (current = undefined) },
        persistence,
        () => NOW
      );
      return { state, persistence };
    };
    expect(memory(tok("a")).state.status().kind).toBe("usable");
    expect(memory(tok("a", NOW - 1)).state.status().kind).toBe("needs-renewal");
    expect(memory(undefined).state.status().kind).toBe("needs-renewal");

    const blocked = memory(tok("a"));
    blocked.state.blockRenewal("interaction-required", 0);
    expect(blocked.state.status()).toMatchObject({ kind: "renewal-blocked", reason: "interaction-required" });

    const dead = memory(tok("a", NOW - 1));
    dead.state.blockRenewal("invalid-token", 0);
    expect(dead.state.status()).toMatchObject({ kind: "action-required", reason: "invalid-token" });
  });
});

describe("only an interactive login lifts a block", () => {
  it("is not lifted by writing a token, by a renewal commit, or by reading status", () => {
    const { store, state } = fileBacked();
    store.write(tok("a"));
    expect(state.blockRenewal("interaction-required", state.epoch())).toBe(true);

    store.write(tok("b")); // a raw store write must not touch renewal state
    expect(state.status()).toMatchObject({ kind: "renewal-blocked" });
    expect(state.commitRenewal(tok("c"), state.epoch())).toBe(false);
    state.status();
    expect(state.status()).toMatchObject({ kind: "renewal-blocked", token: { token: "b" } });

    state.commitLogin(tok("d"));
    expect(state.status()).toMatchObject({ kind: "usable", token: { token: "d" } });
  });
});

describe("epoch compare-and-swap", () => {
  it("lets a sign-out win over a renewal that started earlier", () => {
    const { store, state } = fileBacked();
    store.write(tok("a"));
    const epochAtRenewalStart = state.epoch();

    state.signOut();

    expect(state.commitRenewal(tok("renewed"), epochAtRenewalStart)).toBe(false);
    expect(store.read()).toBeUndefined();
    expect(state.blockRenewal("interaction-required", epochAtRenewalStart)).toBe(false); // does not overwrite the reason
    expect(state.status()).toMatchObject({ kind: "action-required", reason: "signed-out" });
  });

  it("increments the epoch on login and sign-out", () => {
    const { state } = fileBacked();
    expect(state.epoch()).toBe(0);
    state.commitLogin(tok("a"));
    expect(state.epoch()).toBe(1);
    state.signOut();
    expect(state.epoch()).toBe(2);
  });
});

describe("revokeToken", () => {
  it("deletes and blocks only when the rejected token is still the stored one", () => {
    const { store, state } = fileBacked();
    state.commitLogin(tok("old"));
    expect(state.revokeToken("old")).toBe(true);
    expect(store.read()).toBeUndefined();
    expect(state.status()).toMatchObject({ kind: "action-required", reason: "invalid-token" });
  });

  it("leaves a newer token alone and does not block", () => {
    const { store, state } = fileBacked();
    state.commitLogin(tok("old"));
    state.commitLogin(tok("newer")); // another process signed in again
    expect(state.revokeToken("old")).toBe(false);
    expect(store.read()?.token).toBe("newer");
    expect(state.status().kind).toBe("usable");
  });
});

describe("FileStatePersistence", () => {
  it("starts allowed", () => {
    const { persistence } = fileBacked();
    expect(persistence.read()).toMatchObject({ epoch: 0, renewal: "allowed" });
  });

  it("migrates the first release's .action-required marker into the state file", () => {
    const { store, persistence } = fileBacked();
    writeFileSync(store.legacyMarkerPath, "interactive login required\n");
    expect(persistence.read()).toMatchObject({ renewal: "blocked", blockedReason: "signed-out" });
    expect(existsSync(store.legacyMarkerPath)).toBe(false);
    expect(existsSync(store.statePath)).toBe(true);
    expect(JSON.parse(readFileSync(store.statePath, "utf8")).renewal).toBe("blocked");
  });

  it("fails closed when the state file is unreadable", () => {
    const { store, persistence } = fileBacked();
    writeFileSync(store.statePath, "{ not json");
    expect(persistence.read()).toMatchObject({ renewal: "blocked" });
  });
});
