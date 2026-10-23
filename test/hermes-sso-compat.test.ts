import { describe, expect, it, vi } from "vitest";
import {
  assertRealmAllowed,
  compareTargets,
  evaluateCompat,
  listCdpTargetIds,
  parseHermesCompatArgs,
} from "../src/auth/hermes-compat.js";

describe("arguments and the production guard", () => {
  it("requires a known realm", () => {
    expect(() => parseHermesCompatArgs([])).toThrow(/Usage/);
    expect(() => parseHermesCompatArgs(["--realm", "staging"])).toThrow(/Usage/);
    expect(parseHermesCompatArgs(["--realm", "sandbox"])).toEqual({ realm: "sandbox", allowProduction: false });
  });
  it("refuses production without --allow-production, and a mismatched realm", () => {
    const prod = parseHermesCompatArgs(["--realm", "production"]);
    expect(() => assertRealmAllowed("production", prod)).toThrow(/--allow-production/);
    expect(() => assertRealmAllowed("production", { ...prod, allowProduction: true })).not.toThrow();
    expect(() => assertRealmAllowed("sandbox", { realm: "production", allowProduction: true })).toThrow(/does not match/);
    expect(() => assertRealmAllowed("production", { realm: "sandbox", allowProduction: false })).toThrow(/does not match/);
  });
});

describe("target comparison", () => {
  it("ignores the tab the server owns and reports ids only", () => {
    expect(compareTargets(["a", "b"], ["a", "b", "own"], ["own"])).toMatchObject({
      unrelatedTargetsBefore: 2,
      unrelatedTargetsAfter: 2,
      unchanged: true,
    });
    const changed = compareTargets(["a", "b"], ["a", "c"]);
    expect(changed).toMatchObject({ unchanged: false, added: ["c"], removed: ["b"] });
  });
});

describe("evaluateCompat", () => {
  const ok = { realm: "sandbox", targetsBefore: ["a"], targetsAfter: ["a"], first: { uid: "u", fingerprint: "f1" }, second: { uid: "u", fingerprint: "f2" } };
  it("passes when tabs are untouched, mints differ and the user is stable", () => {
    expect(evaluateCompat(ok)).toMatchObject({ ok: true, failures: [] });
  });
  it("fails on a tab change, a repeated token or a different user", () => {
    expect(evaluateCompat({ ...ok, targetsAfter: [] }).ok).toBe(false);
    expect(evaluateCompat({ ...ok, second: { uid: "u", fingerprint: "f1" } }).ok).toBe(false);
    expect(evaluateCompat({ ...ok, second: { uid: "other", fingerprint: "f2" } }).ok).toBe(false);
  });
  it("never puts a URL or token in its output", () => {
    const text = JSON.stringify(evaluateCompat({ ...ok, targetsAfter: ["a", "x"] }));
    expect(text).not.toMatch(/https?:|eyJ/);
  });
});

describe("listCdpTargetIds", () => {
  it("returns ids and always disconnects", async () => {
    const disconnect = vi.fn(async () => undefined);
    await expect(listCdpTargetIds("http://127.0.0.1:9222", async () => ({ targetIds: async () => ["t1", "t2"], disconnect }))).resolves.toEqual(["t1", "t2"]);
    expect(disconnect).toHaveBeenCalledOnce();
    const failing = vi.fn(async () => undefined);
    await expect(
      listCdpTargetIds("http://127.0.0.1:9222", async () => ({ targetIds: async () => { throw new Error("boom"); }, disconnect: failing }))
    ).rejects.toThrow("boom");
    expect(failing).toHaveBeenCalledOnce();
  });
});
