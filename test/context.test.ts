import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfig } from "../src/config.js";
import { getReferenceCache, getRecordCache, getSearchCache, invalidateDomain, resetCaches } from "../src/services/cache.js";
import { resolveAppId, resolvePersonUid, resolvePersonUids } from "../src/services/context.js";
import { combineHints, referenceHint } from "../src/services/hints.js";
import * as client from "../src/services/client.js";

function setEnv(overrides: Record<string, string | undefined> = {}): void {
  process.env.TEAMDYNAMIX_BASE_URL = "https://example.teamdynamix.com";
  process.env.TEAMDYNAMIX_BEID = "b";
  process.env.TEAMDYNAMIX_WS_KEY = "k";
  delete process.env.TEAMDYNAMIX_DEFAULT_APP_ID;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetConfig();
  resetCaches();
}

describe("cache tiers", () => {
  beforeEach(() => setEnv());

  it("purges searches and records on a write but preserves reference data", () => {
    getReferenceCache().set("/49/tickets/statuses", [{ ID: 1, Name: "New" }], 60_000);
    getSearchCache().set("/49/tickets/search?a=1", { items: [] }, 60_000);
    getRecordCache().set("/49/tickets/500", { ID: 500 }, 60_000);

    invalidateDomain(49, "tickets");

    expect(getSearchCache().get("/49/tickets/search?a=1")).toBeUndefined();
    expect(getRecordCache().get("/49/tickets/500")).toBeUndefined();
    expect(getReferenceCache().get("/49/tickets/statuses")).toBeDefined();
  });

  it("scopes invalidation to the written domain", () => {
    getSearchCache().set("/49/assets/search?a=1", { items: [] }, 60_000);
    invalidateDomain(49, "tickets");
    expect(getSearchCache().get("/49/assets/search?a=1")).toBeDefined();
  });

  it("supports app-less domains such as groups", () => {
    getRecordCache().set("/groups/7/members", [], 60_000);
    invalidateDomain(undefined, "groups");
    expect(getRecordCache().get("/groups/7/members")).toBeUndefined();
  });
});

describe("resolveAppId", () => {
  it("prefers an explicit app_id", () => {
    setEnv({ TEAMDYNAMIX_DEFAULT_APP_ID: "671" });
    expect(resolveAppId(123)).toBe(123);
  });

  it("falls back to the configured default", () => {
    setEnv({ TEAMDYNAMIX_DEFAULT_APP_ID: "671" });
    expect(resolveAppId(undefined)).toBe(671);
  });

  it("explains what to do when neither is available", () => {
    setEnv();
    expect(() => resolveAppId(undefined)).toThrow(/teamdynamix_list_applications/);
  });
});

describe("resolvePersonUid", () => {
  beforeEach(() => setEnv());
  afterEach(() => vi.restoreAllMocks());

  it("passes a UID through without a lookup", async () => {
    const request = vi.spyOn(client, "tdRequest");
    await expect(resolvePersonUid("2c3d4e5f-1111-2222-3333-444455556666")).resolves.toBe(
      "2c3d4e5f-1111-2222-3333-444455556666"
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("resolves an exact email match", async () => {
    vi.spyOn(client, "tdRequest").mockResolvedValue([
      { UID: "uid-1", FullName: "Jane Doe", PrimaryEmail: "Jane.Doe@example.edu" },
    ]);
    await expect(resolvePersonUid("jane.doe@example.edu")).resolves.toBe("uid-1");
  });

  it("matches on the alert email as well", async () => {
    vi.spyOn(client, "tdRequest").mockResolvedValue([
      { UID: "uid-2", FullName: "Sam Roe", PrimaryEmail: "other@example.edu", AlertEmail: "sam@example.edu" },
    ]);
    await expect(resolvePersonUid("sam@example.edu")).resolves.toBe("uid-2");
  });

  it("reports when no person has that email", async () => {
    vi.spyOn(client, "tdRequest").mockResolvedValue([]);
    await expect(resolvePersonUid("nobody@example.edu")).rejects.toThrow(/No TeamDynamix person found/);
  });

  it("lists candidates when the email is ambiguous", async () => {
    vi.spyOn(client, "tdRequest").mockResolvedValue([
      { UID: "uid-1", FullName: "Jane Doe", PrimaryEmail: "shared@example.edu" },
      { UID: "uid-2", FullName: "Jan Doe", PrimaryEmail: "shared@example.edu" },
    ]);
    await expect(resolvePersonUid("shared@example.edu")).rejects.toThrow(/Jane Doe \(uid-1\).*Jan Doe \(uid-2\)/s);
  });

  it("ignores near-misses that the lookup returns", async () => {
    vi.spyOn(client, "tdRequest").mockResolvedValue([
      { UID: "uid-9", FullName: "Someone Else", PrimaryEmail: "someone.else@example.edu" },
    ]);
    await expect(resolvePersonUid("some@example.edu")).rejects.toThrow(/No TeamDynamix person found/);
  });

  it("leaves a pure-UID list untouched", async () => {
    const request = vi.spyOn(client, "tdRequest");
    await expect(resolvePersonUids(["uid-1", "uid-2"])).resolves.toEqual(["uid-1", "uid-2"]);
    expect(request).not.toHaveBeenCalled();
  });

  it("resolves mixed lists of UIDs and emails", async () => {
    vi.spyOn(client, "tdRequest").mockResolvedValue([
      { UID: "uid-3", FullName: "Pat Poe", PrimaryEmail: "pat@example.edu" },
    ]);
    await expect(resolvePersonUids(["uid-1", "pat@example.edu"])).resolves.toEqual(["uid-1", "uid-3"]);
  });
});

describe("referenceHint", () => {
  beforeEach(() => setEnv());

  it("lists valid values already held in cache", () => {
    getReferenceCache().set(
      "/49/tickets/statuses",
      [
        { ID: 11, Name: "New" },
        { ID: 12, Name: "Open" },
      ],
      60_000
    );
    expect(referenceHint(49, "tickets/statuses", "status_id values")).toBe(
      "Valid status_id values for app 49: 11 New, 12 Open."
    );
  });

  it("stays silent when the data was never fetched, so no network call is provoked", () => {
    expect(referenceHint(49, "tickets/statuses", "status_id values")).toBeUndefined();
  });

  it("summarizes long lists", () => {
    const many = Array.from({ length: 14 }, (_, index) => ({ ID: index, Name: `S${index}` }));
    getReferenceCache().set("/49/tickets/types", many, 60_000);
    expect(referenceHint(49, "tickets/types", "type_id values")).toMatch(/and 4 more\.$/);
  });

  it("combines only the hints that resolved", () => {
    expect(combineHints(undefined, "a.", undefined, "b.")).toBe("a. b.");
    expect(combineHints(undefined, undefined)).toBeUndefined();
  });
});
