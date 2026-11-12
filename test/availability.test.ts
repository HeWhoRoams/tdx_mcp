import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PromptListChangedNotificationSchema, ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConfig, resetConfig } from "../src/config.js";
import {
  appKeyOf,
  availabilityFromApps,
  getAvailability,
  hasApp,
  isAvailable,
  resetAvailability,
  type AppKey,
  type Availability,
} from "../src/policy/availability.js";
import { decideTool, resolveToolPolicy, ToolPolicyError } from "../src/policy/index.js";
import { ToolPolicyFileSchema } from "../src/policy/schema.js";
import { buildServer, type ServerControls } from "../src/server.js";
import { tdRequest } from "../src/services/client.js";
import { catalog } from "../src/surface/catalog.js";
import { resolveSurface } from "../src/surface/resolve.js";
import { referenceTools } from "../src/tools/reference.js";
import type { TdApp } from "../src/types.js";

vi.mock("../src/services/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/client.js")>();
  return { ...actual, tdRequest: vi.fn() };
});
const tdRequestMock = vi.mocked(tdRequest);

const CLASS_OF: Record<AppKey, { AppClass: string; Type: string }> = {
  tickets: { AppClass: "TDTickets", Type: "Ticketing" },
  assets: { AppClass: "TDAssets", Type: "Asset/CI" },
  projects: { AppClass: "TDProjects", Type: "Projects" },
};
let nextId = 1;
const app = (key: AppKey, overrides: Partial<TdApp> = {}): TdApp => ({
  AppID: nextId++,
  Name: `App ${nextId}`,
  ...CLASS_OF[key],
  Active: true,
  ...overrides,
});
const standard = (): TdApp => ({ AppID: nextId++, Name: "Std", Type: "Standard", AppClass: "TDNext", Active: true });
const known = (...keys: AppKey[]): Availability => ({ known: true, present: new Set(keys) });
const unknown: Availability = { known: false, reason: "test" };

const surfaceOf = (availability?: Availability) => resolveSurface(catalog, getConfig().toolPolicy, availability);
const hiddenTools = (availability?: Availability) =>
  surfaceOf(availability).entries.filter((entry) => entry.kind === "tool" && entry.state === "hidden").map((entry) => entry.name);

const ENV_KEYS = ["TDX_TOOLSETS", "TDX_APP_GATING", "TDX_APP_GATING_TIMEOUT_MS", "TDX_TOOL_POLICY_FILE", "TDX_ALLOW_CAPABILITIES", "TEAMDYNAMIX_READ_ONLY"];

function setEnv(overrides: Record<string, string> = {}): void {
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.TEAMDYNAMIX_BASE_URL = "https://example.teamdynamix.com";
  process.env.TEAMDYNAMIX_BEID = "test-beid";
  process.env.TEAMDYNAMIX_WS_KEY = "test-key";
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
  resetConfig();
  resetAvailability();
}

beforeEach(() => {
  tdRequestMock.mockReset();
  setEnv();
});
afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  resetConfig();
  resetAvailability();
});

describe("application kinds", () => {
  it("prefers AppClass and falls back to the display Type", () => {
    expect(appKeyOf({ AppClass: "TDAssets", Type: "anything" })).toBe("assets");
    expect(appKeyOf({ AppClass: "tdtickets", Type: "x" })).toBe("tickets");
    expect(appKeyOf({ Type: "Asset/CI" } as TdApp)).toBe("assets");
    expect(appKeyOf({ Type: "ASSETS" } as TdApp)).toBe("assets");
    expect(appKeyOf({ Type: "Projects" } as TdApp)).toBe("projects");
  });

  it("recognizes nothing for applications that gate no tools", () => {
    expect(appKeyOf({ AppClass: "TDNext", Type: "Standard" })).toBeUndefined();
    expect(appKeyOf({ AppClass: "TDClient", Type: "Client Portal" })).toBeUndefined();
  });
});

describe("availabilityFromApps", () => {
  it("collects the kinds of active applications only", () => {
    const result = availabilityFromApps([app("tickets"), app("assets", { Active: false }), standard()]);
    expect(result).toEqual({ known: true, present: new Set(["tickets"]) });
  });

  it("fails open on an empty list or one with no recognized kind", () => {
    expect(availabilityFromApps([]).known).toBe(false);
    expect(availabilityFromApps(null).known).toBe(false);
    expect(availabilityFromApps([standard(), app("assets", { Active: false })]).known).toBe(false);
  });

  it("treats an unknown result as everything being available", () => {
    expect(hasApp(unknown, "assets")).toBe(true);
    expect(isAvailable({ requiresApp: "assets" }, unknown).available).toBe(true);
    expect(isAvailable({ requiresApp: null }, known("tickets")).available).toBe(true);
    expect(isAvailable({ requiresApp: "assets" }, known("tickets"))).toEqual({ available: false, reason: "app:assets not present" });
  });
});

describe("getAvailability", () => {
  it("resolves from the application list", async () => {
    tdRequestMock.mockResolvedValue([app("tickets"), app("assets")]);
    const result = await getAvailability({ timeoutMs: 1000 });
    expect(result).toEqual({ known: true, present: new Set(["tickets", "assets"]) });
  });

  it("returns unknown instead of throwing, and remembers the failure briefly", async () => {
    tdRequestMock.mockRejectedValue(new Error("network down"));
    const first = await getAvailability({ timeoutMs: 1000 });
    expect(first.known).toBe(false);
    await getAvailability({ timeoutMs: 1000 });
    expect(tdRequestMock).toHaveBeenCalledTimes(1);
    await getAvailability({ timeoutMs: 1000, bypassNegativeCache: true });
    expect(tdRequestMock).toHaveBeenCalledTimes(2);
  });

  it("gives up at the timeout while the lookup keeps running", async () => {
    tdRequestMock.mockReturnValue(new Promise(() => undefined));
    const started = Date.now();
    const result = await getAvailability({ timeoutMs: 25 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result).toMatchObject({ known: false });
    expect((result as { reason: string }).reason).toContain("exceeded");
  });

  it("uses an already-cached list even with a zero timeout", async () => {
    tdRequestMock.mockResolvedValue([app("projects")]);
    expect(await getAvailability({ timeoutMs: 0 })).toEqual({ known: true, present: new Set(["projects"]) });
  });
});

describe("toolsets", () => {
  const policy = (extra: object = {}) => resolveToolPolicy({ toolsets: ["tickets", "people"], readOnly: false, ...extra });
  const ticketTool = { name: "tdx_get_ticket", domain: "tickets" as const, capability: "read" as const };
  const assetTool = { name: "tdx_get_asset", domain: "assets" as const, capability: "read" as const };

  it("keeps listed domains, authentication and the lookups that serve them", () => {
    const p = policy();
    expect(decideTool(p, ticketTool).allowed).toBe(true);
    expect(decideTool(p, { name: "t", domain: "people", capability: "read" }).allowed).toBe(true);
    expect(decideTool(p, { name: "t", domain: "auth", capability: "read" }).allowed).toBe(true);
    expect(decideTool(p, { name: "t", domain: "reference", capability: "read", serves: ["tickets"] }).allowed).toBe(true);
    expect(decideTool(p, { name: "t", domain: "reference", capability: "read" }).allowed).toBe(true);
  });

  it("drops everything else with a reason", () => {
    const p = policy();
    expect(decideTool(p, assetTool)).toEqual({ allowed: false, reason: "not in toolsets" });
    expect(decideTool(p, { name: "t", domain: "reference", capability: "read", serves: ["cmdb"] }).allowed).toBe(false);
    expect(decideTool(p, { name: "t", domain: "reports", capability: "read" }).allowed).toBe(false);
  });

  it("never overrides the deny list, read-only mode or the capability tiers", () => {
    expect(decideTool(policy({ denyTools: ["tdx_get_ticket"] }), ticketTool).allowed).toBe(false);
    expect(decideTool(policy({ readOnly: true }), { ...ticketTool, capability: "create" }).allowed).toBe(false);
    expect(decideTool(policy(), { ...ticketTool, capability: "edit" }).allowed).toBe(false);
  });

  it("is bypassed by an explicit allow list", () => {
    expect(decideTool(policy({ allowTools: ["tdx_get_asset"] }), assetTool).allowed).toBe(true);
  });

  it("does not make a read-only configuration look writable", () => {
    expect(resolveToolPolicy({ toolsets: ["tickets"], readOnly: true }).mayModify).toBe(false);
    expect(resolveToolPolicy({ toolsets: ["tickets"], allowCapabilities: ["read"], readOnly: false }).mayModify).toBe(false);
  });

  it("reads the policy file and lets the environment override it", () => {
    const fromFile = resolveToolPolicy({ policyData: { toolsets: ["assets"] }, readOnly: false });
    expect([...(fromFile.toolsets ?? [])]).toEqual(["assets"]);
    const overridden = resolveToolPolicy({ policyData: { toolsets: ["assets"] }, toolsets: ["tickets"], readOnly: false });
    expect([...(overridden.toolsets ?? [])]).toEqual(["tickets"]);
  });

  it("rejects unknown domains in the environment and in the file", () => {
    expect(() => resolveToolPolicy({ toolsets: ["tickets", "nope"], readOnly: false })).toThrow(ToolPolicyError);
    expect(ToolPolicyFileSchema.safeParse({ toolsets: ["nope"] }).success).toBe(false);
    expect(ToolPolicyFileSchema.safeParse({ toolsets: ["tickets"] }).success).toBe(true);
  });

  it("is read from TDX_TOOLSETS", () => {
    setEnv({ TDX_TOOLSETS: "tickets, people" });
    const names = surfaceOf().registered("tool");
    expect(names).toContain("tdx_get_ticket");
    expect(names).toContain("tdx_get_ticket_reference");
    expect(names).toContain("tdx_list_applications");
    expect(names).toContain("tdx_get_current_user");
    expect(names).not.toContain("tdx_search_assets");
    expect(names).not.toContain("tdx_get_asset_reference");
    expect(names).not.toContain("tdx_get_report");
  });
});

describe("the shipped tool catalog", () => {
  it("makes every reference tool state which application it needs", () => {
    for (const definition of referenceTools) {
      expect(definition.requiresApp, definition.name).not.toBeUndefined();
    }
  });

  it("registers 46 tools when availability is unknown or complete", () => {
    expect(surfaceOf().registered("tool")).toHaveLength(46);
    expect(hiddenTools(unknown)).toHaveLength(0);
    expect(hiddenTools(known("tickets", "assets", "projects"))).toHaveLength(0);
  });

  it("hides exactly the 14 asset and CMDB tools when there is no Asset/CI application", () => {
    const surface = surfaceOf(known("tickets", "projects"));
    expect(surface.counts.tool.hidden).toBe(14);
    expect(surface.counts.tool.registered).toBe(32);
    const names = hiddenTools(known("tickets", "projects"));
    expect(names).toContain("tdx_search_assets");
    expect(names).toContain("tdx_link_ci_to_ticket");
    expect(names).toContain("tdx_get_asset_reference");
    expect(names).toContain("tdx_get_asset_reference");
    expect(names).not.toContain("tdx_list_applications");
  });

  it("never gates people, reports, authentication or the generic lookups", () => {
    const gated = new Set(hiddenTools(known("tickets")));
    for (const name of ["tdx_lookup_people", "tdx_get_report", "tdx_get_current_user", "tdx_list_accounts", "tdx_list_locations", "tdx_list_custom_attributes"]) {
      expect(gated.has(name), name).toBe(false);
    }
  });
});

// ── A real client and server over an in-memory transport ───────────────────────────────────────

async function connect(controls: ServerControls) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const events = { tools: 0, prompts: 0 };
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => void (events.tools += 1));
  client.setNotificationHandler(PromptListChangedNotificationSchema, async () => void (events.prompts += 1));
  await controls.server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, events };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const toolNames = async (client: Client) => (await client.listTools()).tools.map((tool) => tool.name);

describe("over the MCP protocol", () => {
  it("prunes after start-up with one tools/list_changed and updates the tool and prompt lists", async () => {
    const controls = buildServer();
    const { client, events } = await connect(controls);
    expect(await toolNames(client)).toHaveLength(46);
    expect((await client.listPrompts()).prompts.length).toBeGreaterThan(0);

    const hidden = controls.applyAvailability(known("assets"));
    await settle();
    expect(hidden).toContain("tdx_get_ticket");
    expect(events.tools).toBe(1);
    expect(events.prompts).toBe(1);
    const names = await toolNames(client);
    expect(names).not.toContain("tdx_get_ticket");
    expect(names).toContain("tdx_search_assets");
    expect((await client.listPrompts()).prompts).toHaveLength(0);

    controls.applyAvailability(known("assets"));
    await settle();
    expect(events.tools).toBe(1);
    await client.close();
  });

  it("registers a pruned list from the start when availability is known", async () => {
    const controls = buildServer({ availability: known("tickets", "projects") });
    const { client, events } = await connect(controls);
    const names = await toolNames(client);
    expect(names).toHaveLength(32);
    expect(names).not.toContain("tdx_search_assets");
    expect(events.tools).toBe(0);
    await client.close();
  });

  it("registers everything when the application lookup failed", async () => {
    tdRequestMock.mockRejectedValue(new Error("network down"));
    const availability = await getAvailability({ timeoutMs: 100 });
    const { client } = await connect(buildServer({ availability }));
    expect(await toolNames(client)).toHaveLength(46);
    await client.close();
  });

  it("tells the model which areas are missing, and lists only the areas that exist", async () => {
    const full = await connect(buildServer());
    expect(full.client.getInstructions()).toContain("ticketing, assets, CMDB, projects, issues, people, and reports");
    await full.client.close();

    const pruned = await connect(buildServer({ availability: known("tickets", "projects") }));
    const text = pruned.client.getInstructions() ?? "";
    expect(text).toContain("Asset and CMDB tools are not registered because no Asset/CI application is available to this account.");
    expect(text).toContain("TeamDynamix ticketing, projects, issues, people, and reports.");
    expect(text).toContain("change TeamDynamix records");
    await pruned.client.close();
  });

  it("states the toolsets in the instructions", async () => {
    setEnv({ TDX_TOOLSETS: "tickets,people" });
    const { client } = await connect(buildServer());
    expect(client.getInstructions()).toContain("This server exposes only these areas: tickets, people.");
    expect(await toolNames(client)).not.toContain("tdx_search_assets");
    await client.close();
  });
});
