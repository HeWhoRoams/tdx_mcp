import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfig } from "../src/config.js";
import type { AppKey, Availability } from "../src/policy/availability.js";
import { resetAvailability } from "../src/policy/availability.js";
import { buildServer } from "../src/server.js";

/**
 * Pins what a client observes (tools, prompts, instructions) for combinations of policy and
 * application availability. It crosses only the MCP protocol, so internal refactors of the
 * registration path must leave it unchanged.
 */

const ENV_KEYS = [
  "TDX_TOOLSETS",
  "TDX_APP_GATING",
  "TDX_TOOL_POLICY_FILE",
  "TDX_ALLOW_CAPABILITIES",
  "TDX_ALLOW_TOOLS",
  "TDX_DENY_TOOLS",
  "TEAMDYNAMIX_READ_ONLY",
];

function setEnv(overrides: Record<string, string>): void {
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.TEAMDYNAMIX_BASE_URL = "https://example.teamdynamix.com";
  process.env.TEAMDYNAMIX_BEID = "test-beid";
  process.env.TEAMDYNAMIX_WS_KEY = "test-key";
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
  resetConfig();
  resetAvailability();
}

beforeEach(() => setEnv({}));
afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  resetConfig();
  resetAvailability();
});

const known = (...keys: AppKey[]): Availability => ({ known: true, present: new Set(keys) });
const ALL_APPS: AppKey[] = ["tickets", "assets", "projects"];

const POLICIES: Record<string, Record<string, string>> = {
  default: {},
  "read-only": { TEAMDYNAMIX_READ_ONLY: "true" },
  "toolsets tickets": { TDX_TOOLSETS: "tickets" },
  "allow list": { TDX_ALLOW_TOOLS: "tdx_get_ticket,tdx_search_assets" },
};

const AVAILABILITY: Record<string, Availability | undefined> = {
  "gating off": undefined,
  unknown: { known: false, reason: "test" },
  "all apps": known(...ALL_APPS),
  "no assets": known("tickets", "projects"),
  "no projects": known("tickets", "assets"),
  "no tickets": known("assets", "projects"),
};

/** One server driven through a real client; the only place that knows how a server is built. */
async function observe(availability: Availability | undefined) {
  const controls = buildServer(availability ? { availability } : {});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await controls.server.connect(serverTransport);
  await client.connect(clientTransport);
  // A server with nothing registered in a list does not advertise the capability at all.
  const tools = await client.listTools().then((r) => r.tools.map((tool) => tool.name).sort(), () => [] as string[]);
  const prompts = await client.listPrompts().then((r) => r.prompts.map((prompt) => prompt.name).sort(), () => [] as string[]);
  const instructions = client.getInstructions() ?? "";
  await client.close();
  return { tools, prompts, instructions };
}

describe("tool surface as a client sees it", () => {
  for (const [policyName, env] of Object.entries(POLICIES)) {
    for (const [availabilityName, availability] of Object.entries(AVAILABILITY)) {
      it(`${policyName} / ${availabilityName}`, async () => {
        setEnv(env);
        const seen = await observe(availability);
        expect({ count: seen.tools.length, ...seen }).toMatchSnapshot();
      });
    }
  }

  it("keeps the headline counts the documentation promises", async () => {
    expect((await observe(undefined)).tools).toHaveLength(46);
    expect((await observe(known("tickets", "projects"))).tools).toHaveLength(32);
    setEnv({ TEAMDYNAMIX_READ_ONLY: "true" });
    expect((await observe(undefined)).tools).toHaveLength(34);
  });
});
