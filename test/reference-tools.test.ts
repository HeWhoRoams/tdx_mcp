import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfig } from "../src/config.js";
import { tdRequest } from "../src/services/client.js";
import { referenceTools } from "../src/tools/reference.js";
import { registerResources } from "../src/resources/index.js";
import { mountTools } from "./helpers/mountTools.js";

vi.mock("../src/services/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/client.js")>();
  return { ...actual, tdRequest: vi.fn() };
});
const tdRequestMock = vi.mocked(tdRequest);

type Result = { isError?: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, unknown> };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

function setEnv(extra: Record<string, string> = {}): void {
  delete process.env.TEAMDYNAMIX_DEFAULT_APP_ID;
  process.env.TEAMDYNAMIX_BASE_URL = "https://example.teamdynamix.com";
  process.env.TEAMDYNAMIX_BEID = "test-beid";
  process.env.TEAMDYNAMIX_WS_KEY = "test-key";
  for (const [key, value] of Object.entries(extra)) process.env[key] = value;
  resetConfig();
}

function handlers(): Map<string, Handler> {
  const captured = new Map<string, Handler>();
  mountTools({ registerTool: (name: string, _config: unknown, handler: Handler) => void captured.set(name, handler) }, referenceTools);
  return captured;
}

const list = (...names: string[]) => names.map((Name, index) => ({ ID: index + 1, Name }));
const byEndpoint: Record<string, unknown> = {
  "/49/tickets/types": list("Incident", "Request"),
  "/49/tickets/statuses": list("New", "Closed"),
  "/49/tickets/priorities": list("High"),
  "/49/tickets/urgencies": list("Soon"),
  "/49/assets/statuses": list("In Use"),
  "/49/cmdb/types": list("Server"),
};

beforeEach(() => {
  tdRequestMock.mockReset();
  tdRequestMock.mockImplementation(async (endpoint: string) => (byEndpoint[endpoint] ?? []) as never);
  setEnv();
});
afterEach(() => {
  delete process.env.TEAMDYNAMIX_DEFAULT_APP_ID;
  resetConfig();
});

describe("get_ticket_reference", () => {
  it("returns types, statuses and priorities by default, cached under the endpoint paths", async () => {
    const result = await handlers().get("tdx_get_ticket_reference")!({ app_id: 49 });
    const text = result.content[0]!.text;
    expect(text).toContain("# Ticket Types");
    expect(text).toContain("**Incident** (ID: 1)");
    expect(text).toContain("# Ticket Statuses");
    expect(text).toContain("# Ticket Priorities");
    expect(text).not.toContain("Urgencies");
    const calls = tdRequestMock.mock.calls.map(([endpoint, options]) => [endpoint, options?.cacheKey]);
    expect(calls).toEqual([
      ["/49/tickets/types", "/49/tickets/types"],
      ["/49/tickets/statuses", "/49/tickets/statuses"],
      ["/49/tickets/priorities", "/49/tickets/priorities"],
    ]);
  });

  it("returns exactly the requested kinds once each, in order", async () => {
    const result = await handlers().get("tdx_get_ticket_reference")!({ app_id: 49, kinds: ["urgencies", "types", "urgencies"] });
    expect(tdRequestMock).toHaveBeenCalledTimes(2);
    const text = result.content[0]!.text;
    expect(text.indexOf("Ticket Urgencies")).toBeLessThan(text.indexOf("Ticket Types"));
  });

  it("keeps the other lists when one cannot be loaded", async () => {
    tdRequestMock.mockImplementation(async (endpoint: string) => {
      if (endpoint.endsWith("/statuses")) throw new Error("boom");
      return (byEndpoint[endpoint] ?? []) as never;
    });
    const result = await handlers().get("tdx_get_ticket_reference")!({ app_id: 49 });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain("# Ticket Types");
    expect(result.content[0]!.text).toMatch(/# Ticket Statuses\s+_Could not be loaded: /);
  });

  it("fails the call when every list fails", async () => {
    tdRequestMock.mockRejectedValue(new Error("boom"));
    const result = await handlers().get("tdx_get_ticket_reference")!({ app_id: 49 });
    expect(result.isError).toBe(true);
  });

  it("returns structured data keyed by kind for json", async () => {
    const result = await handlers().get("tdx_get_ticket_reference")!({ app_id: 49, kinds: ["types"], response_format: "json" });
    expect(result.structuredContent).toEqual({ kinds: ["types"], reference: { types: list("Incident", "Request") }, errors: {} });
  });

  it("uses the configured default application", async () => {
    setEnv({ TEAMDYNAMIX_DEFAULT_APP_ID: "49" });
    await handlers().get("tdx_get_ticket_reference")!({ kinds: ["types"] });
    expect(tdRequestMock.mock.calls[0]![0]).toBe("/49/tickets/types");
  });

  it("explains when there is nothing to show", async () => {
    const result = await handlers().get("tdx_get_ticket_reference")!({ app_id: 49, kinds: ["forms"] });
    expect(result.content[0]!.text).toBe("No results found.");
  });
});

describe("get_asset_reference", () => {
  it("returns asset statuses and CI types by default", async () => {
    const result = await handlers().get("tdx_get_asset_reference")!({ app_id: 49 });
    expect(result.content[0]!.text).toContain("# Asset Statuses");
    expect(result.content[0]!.text).toContain("# CI Types");
    expect(tdRequestMock.mock.calls.map(([endpoint]) => endpoint)).toEqual(["/49/assets/statuses", "/49/cmdb/types"]);
  });
});

describe("the reference tool inputs", () => {
  const input = (name: string) => referenceTools.find((tool) => tool.name === name)!.input;

  it("rejects unknown and empty kinds", () => {
    expect(input("tdx_get_ticket_reference").safeParse({ kinds: ["nope"] }).success).toBe(false);
    expect(input("tdx_get_ticket_reference").safeParse({ kinds: [] }).success).toBe(false);
    expect(input("tdx_get_asset_reference").safeParse({ kinds: ["ci_types"] }).success).toBe(true);
  });

  it("keeps each kind with its own tool", () => {
    expect(input("tdx_get_asset_reference").safeParse({ kinds: ["types"] }).success).toBe(false);
  });
});

describe("ticket-reference resource", () => {
  type ResourceHandler = (uri: URL, variables: Record<string, string>) => Promise<{ contents: Array<{ text: string }> }>;

  function ticketReferenceHandler(): ResourceHandler {
    let handler: ResourceHandler | undefined;
    registerResources({
      registerResource: (name: string, _uri: unknown, _meta: unknown, read: ResourceHandler) => {
        if (name === "ticket-reference") handler = read;
      },
    } as never);
    return handler!;
  }

  it("rejects an app id that is not a positive integer, without any request", async () => {
    const read = ticketReferenceHandler();
    await expect(read(new URL("tdx://abc/ticket-reference"), { appId: "abc" })).rejects.toThrow(/positive integer/);
    await expect(read(new URL("tdx://0/ticket-reference"), { appId: "0" })).rejects.toThrow(/positive integer/);
    expect(tdRequestMock).not.toHaveBeenCalled();
  });

  it("returns types, statuses and priorities from the same cached requests as the tool", async () => {
    const read = ticketReferenceHandler();
    const result = await read(new URL("tdx://49/ticket-reference"), { appId: "49" });
    const body = JSON.parse(result.contents[0]!.text);
    expect(body.appId).toBe(49);
    expect(body.types).toHaveLength(2);
    expect(body.statuses).toHaveLength(2);
    expect(body.priorities).toHaveLength(1);
    expect(body.errors).toBeUndefined();
    const calls = tdRequestMock.mock.calls.map(([endpoint, options]) => [endpoint, options?.cacheKey]);
    expect(calls).toEqual([
      ["/49/tickets/types", "/49/tickets/types"],
      ["/49/tickets/statuses", "/49/tickets/statuses"],
      ["/49/tickets/priorities", "/49/tickets/priorities"],
    ]);
  });

  it("returns an empty list and an error for a list that failed", async () => {
    tdRequestMock.mockImplementation(async (endpoint: string) => {
      if (endpoint.endsWith("/statuses")) throw new Error("boom");
      return list("A") as never;
    });
    const result = await ticketReferenceHandler()(new URL("tdx://49/ticket-reference"), { appId: "49" });
    const body = JSON.parse(result.contents[0]!.text);
    expect(body.statuses).toEqual([]);
    expect(Object.keys(body.errors)).toEqual(["statuses"]);
    expect(body.types).toHaveLength(1);
  });
});
