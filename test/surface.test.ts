import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PromptListChangedNotificationSchema, ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CREATE, READ } from "../src/framework/annotations.js";
import { definePrompt } from "../src/framework/definePrompt.js";
import { defineTool, withDomain, type AnyToolDefinition } from "../src/framework/defineTool.js";
import type { AppKey, Availability } from "../src/policy/availability.js";
import { resolveToolPolicy } from "../src/policy/index.js";
import { catalog as shipped, type Catalog } from "../src/surface/catalog.js";
import { mountSurface } from "../src/surface/mount.js";
import { resolveSurface, unknownPolicyNames } from "../src/surface/resolve.js";

const Input = z.object({ response_format: z.enum(["markdown", "json"]).default("markdown") });
const make = (name: string, domain: "tickets" | "assets" | "people", annotations = READ) =>
  withDomain(domain, [
    defineTool({ name, title: name, description: name, input: Input, annotations, handler: async () => ({ items: [] }), render: () => "" }),
  ])[0]!;

const tools: AnyToolDefinition[] = [
  make("t_ticket", "tickets"),
  make("t_ticket_write", "tickets", CREATE),
  make("t_asset", "assets"),
  make("t_person", "people"),
];
const prompt = (name: string, uses: string[]) =>
  definePrompt({ name, title: name, description: name, args: { id: z.string() }, uses, text: ({ id }) => `do ${name} ${id}` });
const catalog: Catalog = { tools, prompts: [prompt("p_ticket", ["t_ticket"]), prompt("p_asset", ["t_asset"]), prompt("p_both", ["t_ticket", "t_asset"])] };

const known = (...keys: AppKey[]): Availability => ({ known: true, present: new Set(keys) });
const unknown: Availability = { known: false, reason: "test" };
const policy = (input: Parameters<typeof resolveToolPolicy>[0] = { readOnly: false }) => resolveToolPolicy(input);

describe("requiresAuth", () => {
  const signIn = defineTool({
    name: "t_sign_in",
    title: "t_sign_in",
    description: "t_sign_in",
    input: Input,
    annotations: READ,
    requiresAuth: { method: "sso", deployment: "local" },
    handler: async () => ({ items: [] }),
    render: () => "",
  });
  const withSignIn: Catalog = { tools: [signIn], prompts: [] };

  it("is offered only to local SSO", () => {
    expect(resolveSurface(withSignIn, policy(), undefined, { method: "sso", deployment: "local" }).registered("tool")).toEqual(["t_sign_in"]);
    for (const auth of [{ method: "admin" }, { method: "user" }, { method: "sso", deployment: "external" }, undefined]) {
      const surface = resolveSurface(withSignIn, policy(), undefined, auth);
      expect(surface.registered("tool")).toEqual([]);
      expect(surface.stateOf("tool", "t_sign_in")).toBe("unsupported");
    }
  });

  it("is never counted as gated by a missing application", () => {
    const surface = resolveSurface(withSignIn, policy(), known("tickets"), { method: "admin" });
    expect(surface.counts.tool).toMatchObject({ hidden: 0, unsupported: 1 });
    expect(surface.gatedApps).toEqual([]);
  });
});

describe("resolveSurface", () => {
  it("registers everything the policy allows when availability is unknown or not supplied", () => {
    for (const availability of [undefined, unknown]) {
      const surface = resolveSurface(catalog, policy(), availability);
      expect(surface.registered("tool")).toEqual(["t_ticket", "t_ticket_write", "t_asset", "t_person"]);
      expect(surface.registered("prompt")).toEqual(["p_ticket", "p_asset", "p_both"]);
      expect(surface.gatedApps).toEqual([]);
    }
  });

  it("hides tools whose application is known to be missing, and the prompts that use them", () => {
    const surface = resolveSurface(catalog, policy(), known("tickets"));
    expect(surface.registered("tool")).toEqual(["t_ticket", "t_ticket_write", "t_person"]);
    expect(surface.registered("prompt")).toEqual(["p_ticket"]);
    expect(surface.gatedApps).toEqual(["assets"]);
    expect(surface.counts.tool).toEqual({ registered: 3, denied: 0, hidden: 1, unsupported: 0 });
    expect(surface.entries.find((e) => e.name === "t_asset")).toMatchObject({ state: "hidden", reason: "hidden: app:assets not present" });
    expect(surface.entries.find((e) => e.name === "p_asset")?.reason).toBe("hidden: it uses t_asset, which is not registered");
  });

  it("denies by policy first, and a denied tool is never reported as gated", () => {
    const surface = resolveSurface(catalog, policy({ readOnly: true }), known("tickets"));
    expect(surface.stateOf("tool", "t_ticket_write")).toBe("denied");
    expect(surface.stateOf("tool", "t_asset")).toBe("hidden");
    expect(surface.entries.find((e) => e.name === "t_ticket_write")?.reason).toBe("denied by policy: TEAMDYNAMIX_READ_ONLY=true");
  });

  it("hides a prompt when policy removes a tool it uses, even if the application exists", () => {
    const surface = resolveSurface(catalog, policy({ readOnly: false, denyTools: ["t_ticket"] }), known("tickets", "assets"));
    expect(surface.registered("prompt")).toEqual(["p_asset"]);
    expect(surface.stateOf("prompt", "p_ticket")).toBe("hidden");
  });

  it("reports the areas that have a registered tool", () => {
    const surface = resolveSurface(catalog, policy(), known("tickets"));
    expect([...surface.areas].sort()).toEqual(["people", "tickets"]);
  });

  it("applies toolsets before the capability rules", () => {
    const surface = resolveSurface(catalog, policy({ readOnly: false, toolsets: ["people"] }));
    expect(surface.registered("tool")).toEqual(["t_person"]);
    expect(surface.entries.find((e) => e.name === "t_ticket")?.reason).toBe("denied by policy: not in toolsets");
  });

  it("names policy entries that match no tool", () => {
    const p = policy({ readOnly: false, denyTools: ["t_ticket", "typo_tool"], allowTools: ["other_typo"] });
    expect(unknownPolicyNames(catalog, p).sort()).toEqual(["other_typo", "typo_tool"]);
  });
});

describe("the shipped catalog", () => {
  it("only lets prompts use tools that exist", () => {
    const names = new Set(shipped.tools.map((tool) => tool.name));
    for (const prompt of shipped.prompts) for (const used of prompt.uses) expect(names.has(used), `${prompt.name} uses ${used}`).toBe(true);
  });
});

// ── Mounting on a real server over an in-memory transport ──────────────────────────────────────

async function mountOnRealServer(availability?: Availability, p = policy()) {
  const server = new McpServer({ name: "t", version: "0" });
  const mounted = mountSurface(server, catalog, resolveSurface(catalog, p, availability), p);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  const events = { tools: 0, prompts: 0 };
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => void (events.tools += 1));
  client.setNotificationHandler(PromptListChangedNotificationSchema, async () => void (events.prompts += 1));
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, mounted, events, p };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const names = async (client: Client) => (await client.listTools()).tools.map((t) => t.name);

describe("mountSurface", () => {
  it("advertises exactly what the surface registers", async () => {
    const { client, mounted } = await mountOnRealServer(known("tickets"));
    expect(await names(client)).toEqual(mounted.surface.registered("tool"));
    const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
    expect(prompts).toEqual(["p_ticket"]);
    const result = await client.getPrompt({ name: "p_ticket", arguments: { id: "7" } });
    expect(result.messages[0]?.content).toMatchObject({ type: "text", text: "do p_ticket 7" });
    await client.close();
  });

  it("prunes late with one notification per list, and only once", async () => {
    const { client, mounted, events, p } = await mountOnRealServer(unknown);
    expect(await names(client)).toHaveLength(4);
    const next = resolveSurface(catalog, p, known("tickets"));

    expect(mounted.apply(next)).toEqual({ hiddenTools: ["t_asset"], hiddenPrompts: ["p_asset", "p_both"] });
    await settle();
    expect(events).toEqual({ tools: 1, prompts: 1 });
    expect(await names(client)).not.toContain("t_asset");
    expect((await client.listPrompts()).prompts.map((x) => x.name)).toEqual(["p_ticket"]);

    expect(mounted.apply(next)).toEqual({ hiddenTools: [], hiddenPrompts: [] });
    await settle();
    expect(events).toEqual({ tools: 1, prompts: 1 });
    await client.close();
  });

  it("does nothing when the later availability is still unknown, and never re-enables", async () => {
    const { client, mounted, events, p } = await mountOnRealServer(known("tickets"));
    expect(mounted.apply(resolveSurface(catalog, p, unknown))).toEqual({ hiddenTools: [], hiddenPrompts: [] });
    await settle();
    expect(events).toEqual({ tools: 0, prompts: 0 });
    expect(await names(client)).not.toContain("t_asset");
    await client.close();
  });

  it("refuses a call to a tool the policy denies even if it were somehow registered", async () => {
    const denied = policy({ readOnly: false, denyTools: ["t_ticket"] });
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>>();
    const fake = { registerTool: (name: string, _c: unknown, h: never) => void handlers.set(name, h) };
    // Mount under a permissive policy, then invoke with the stricter one the handler was given.
    const permissive = resolveSurface(catalog, policy(), undefined);
    mountSurface(fake as unknown as McpServer, { tools, prompts: [] }, permissive, denied);
    const result = await handlers.get("t_ticket")!({ response_format: "markdown" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("disabled on this server by policy");
  });

  it("tolerates a server that returns no handles", () => {
    const fake = { registerTool: () => undefined, registerPrompt: () => undefined, sendToolListChanged: () => undefined, sendPromptListChanged: () => undefined };
    const p = policy();
    const mounted = mountSurface(fake as unknown as McpServer, catalog, resolveSurface(catalog, p), p);
    expect(mounted.apply(resolveSurface(catalog, p, known("tickets")))).toEqual({ hiddenTools: [], hiddenPrompts: [] });
  });
});
