import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfig } from "../src/config.js";
import { resetCaches } from "../src/services/cache.js";
import * as client from "../src/services/client.js";
import { ToolInputError } from "../src/services/errors.js";
import { normalizeArgs, resolveAppReference, resolveReferenceValue } from "../src/services/names.js";
import { ticketTools } from "../src/tools/tickets.js";

const STATUSES = [
  { ID: 1, Name: "New", IsActive: true },
  { ID: 2, Name: "In Process", IsActive: true },
  { ID: 3, Name: "On Hold", IsActive: true },
  { ID: 4, Name: "On Hold - Vendor", IsActive: true },
  { ID: 9, Name: "Retired", IsActive: false },
];
const APPS = [
  { AppID: 5, Name: "Help Desk", Type: "Ticketing", Active: true },
  { AppID: 6, Name: "Assets", Type: "Assets/CIs", Active: true },
];

beforeEach(() => {
  process.env.TEAMDYNAMIX_BASE_URL = "https://example.teamdynamix.com";
  process.env.TEAMDYNAMIX_BEID = "b";
  process.env.TEAMDYNAMIX_WS_KEY = "k";
  resetConfig();
  resetCaches();
  vi.spyOn(client, "tdRequest").mockImplementation((async (endpoint: string) => {
    if (endpoint === "/applications") return APPS;
    if (endpoint === "/5/tickets/statuses") return STATUSES;
    throw new Error(`unexpected ${endpoint}`);
  }) as never);
});
afterEach(() => vi.restoreAllMocks());

const spec = { table: "ticket", kind: "statuses" } as const;

describe("resolveReferenceValue", () => {
  it("passes numbers and numeric strings through without a lookup", async () => {
    expect(await resolveReferenceValue(5, spec, 3)).toBe(3);
    expect(await resolveReferenceValue(5, spec, "3")).toBe(3);
    expect(client.tdRequest).not.toHaveBeenCalled();
  });
  it("matches exactly, ignoring case", async () => {
    expect(await resolveReferenceValue(5, spec, "on hold")).toBe(3);
  });
  it("accepts a single partial match", async () => {
    expect(await resolveReferenceValue(5, spec, "process")).toBe(2);
  });
  it("rejects an ambiguous partial match and lists choices", async () => {
    await expect(resolveReferenceValue(5, spec, "hold -")).resolves.toBe(4);
    await expect(resolveReferenceValue(5, spec, "o")).rejects.toThrow(/matches several/);
  });
  it("lists valid values for an unknown name, without inactive entries", async () => {
    const error = await resolveReferenceValue(5, spec, "bogus").catch((e) => e);
    expect(error).toBeInstanceOf(ToolInputError);
    expect(error.message).toContain("3 On Hold");
    expect(error.message).not.toContain("Retired");
  });
  it("matches an inactive entry only by its full name", async () => {
    expect(await resolveReferenceValue(5, spec, "Retired")).toBe(9);
    await expect(resolveReferenceValue(5, spec, "Retir")).rejects.toThrow(/No ticket statuses/);
  });
});

describe("resolveAppReference", () => {
  it("resolves a name, honouring the app kind", async () => {
    expect(await resolveAppReference("help desk", "tickets")).toBe(5);
    await expect(resolveAppReference("Assets", "tickets")).rejects.toThrow(/No application is named/);
  });
});

describe("normalizeArgs", () => {
  const search = ticketTools.find((t) => t.name === "tdx_search_tickets")!;
  it("turns names into IDs for the app named", async () => {
    const out = await normalizeArgs(search, { app_id: "Help Desk", status_ids: ["On Hold", 1, "2"] });
    expect(out).toMatchObject({ app_id: 5, status_ids: [3, 1, 2] });
  });
  it("leaves numeric calls untouched and makes no requests", async () => {
    const args = { app_id: 5, status_ids: [1, 2] };
    expect(await normalizeArgs(search, args)).toEqual(args);
    expect(client.tdRequest).not.toHaveBeenCalled();
  });
});

describe("'me'", () => {
  it("is refused under a service account", async () => {
    const { resolvePersonUid } = await import("../src/services/context.js");
    await expect(resolvePersonUid("me")).rejects.toThrow(/sso/i);
  });
});
